import { NextRequest, NextResponse } from 'next/server'
import { readBoundedRequestBody, ORCHESTRATION_WEBHOOK_BODY_LIMIT_BYTES } from '@/lib/payments/webhook-body-reader'
import { verifyPayoutsWebhookSignature } from '@/lib/payments/providers/peach/payouts-webhook-signature'
import { loadPeachPayoutsConfig } from '@/lib/payments/providers/peach/payouts-config'
import { applyBankVerificationWebhookPayload } from '@/lib/payments/payout-destinations/service'

/**
 * E32: Peach bank-account-verification (BANV) webhook intake. Separate
 * route from /api/payments/webhooks/[provider] -- BANV is not a payment-
 * provider delivery (it never carries a payment/refund/payout state
 * transition), and the generic route's dispatch/reconciliation chain is
 * narrowly coupled to payment semantics (confirmed by this phase's own
 * codebase audit). Reuses the SAME provider-neutral
 * payment_webhook_events table and its claim/complete/error lease RPCs
 * unchanged, under provider value 'peach_banv' -- no new webhook ledger.
 *
 * Signature scheme is Standard Webhooks/Svix (webhook-id/webhook-
 * timestamp/webhook-signature), genuinely different from the generic
 * route's Checkout/OPPWA schemes -- see
 * lib/payments/providers/peach/payouts-webhook-signature.ts.
 *
 * Known limitation: if record_bank_verification_result raises because
 * the delivery references an attempt this system never created (e.g. a
 * stray/malicious delivery), this is treated the same as any other
 * transient failure (mark_webhook_event_error, 503) rather than being
 * specially classified as permanently unrecoverable -- safe (no
 * incorrect state mutation either way) but not maximally efficient;
 * Peach's own retry schedule eventually stops retrying on its own.
 */
const PROVIDER = 'peach_banv'
const STALE_LEASE_SECONDS = 30

export async function POST(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Payment storage is not configured' }, { status: 503 })
  }

  const config = loadPeachPayoutsConfig()
  if (!config || !config.webhookSigningSecret) {
    // Matches the generic route's "unknown provider -> 404" posture --
    // if this isn't configured, the endpoint behaves as if it doesn't
    // exist, rather than accepting and silently dropping deliveries.
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const bodyResult = await readBoundedRequestBody(request, ORCHESTRATION_WEBHOOK_BODY_LIMIT_BYTES)
  if (!bodyResult.ok) {
    console.error('[payments.webhook.peach_banv] request body rejected', { reason: bodyResult.reason })
    return NextResponse.json({ error: 'Request body too large' }, { status: 413 })
  }
  const rawBody = bodyResult.bytes.toString('utf-8')

  const headers: Record<string, string | null> = {}
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value
  })

  const { createClient: createServiceClient } = await import('@supabase/supabase-js')
  const admin = createServiceClient(url, serviceKey)

  const verification = verifyPayoutsWebhookSignature({ headers, rawBody, secret: config.webhookSigningSecret })
  const webhookId = headers['webhook-id']

  if (!verification.valid || !webhookId) {
    console.error('[payments.webhook.peach_banv] authentication failed', { reason: verification.reason })
    try {
      await admin.rpc('record_webhook_event', {
        p_provider: PROVIDER,
        p_provider_event_id: webhookId ?? `invalid_${Date.now()}`,
        p_signature_valid: false,
        p_payload: safeParseForAudit(rawBody),
      })
    } catch (recordErr) {
      console.error('[payments.webhook.peach_banv] failed to record invalid-auth audit', { recordErr })
    }
    return NextResponse.json({ error: 'Invalid webhook authentication' }, { status: 401 })
  }

  let payload: unknown
  try {
    payload = JSON.parse(rawBody)
  } catch {
    payload = null
  }

  const { data: recordResult, error: recordError } = await admin.rpc('record_webhook_event', {
    p_provider: PROVIDER,
    p_provider_event_id: webhookId,
    p_signature_valid: true,
    p_payload: payload,
  })
  if (recordError) {
    console.error('[payments.webhook.peach_banv] record error', { recordError })
    return NextResponse.json({ error: 'Could not record webhook event' }, { status: 500 })
  }
  void recordResult

  const { data: claimResult, error: claimError } = await admin.rpc('claim_webhook_event_processing', {
    p_provider: PROVIDER,
    p_provider_event_id: webhookId,
    p_stale_after_seconds: STALE_LEASE_SECONDS,
  })
  if (claimError) {
    console.error('[payments.webhook.peach_banv] claim error', { claimError })
    return NextResponse.json({ error: 'Could not process webhook event' }, { status: 500 })
  }
  if (!claimResult?.claimed) {
    return NextResponse.json({ status: 'no_action', processing_status: claimResult?.processing_status })
  }

  const claimToken: number = claimResult.processing_attempts

  try {
    const result = await applyBankVerificationWebhookPayload({ admin }, payload)
    if (!result) {
      const { data: errorMarkResult } = await admin.rpc('mark_webhook_event_error', {
        p_provider: PROVIDER,
        p_provider_event_id: webhookId,
        p_expected_processing_attempt: claimToken,
        p_last_error: 'unrecognized BANV webhook payload shape',
      })
      logIfLostClaim('mark_webhook_event_error (unrecognized shape)', errorMarkResult)
      return NextResponse.json({ error: 'Unrecognized webhook payload' }, { status: 400 })
    }

    const { data: processedResult, error: processedError } = await admin.rpc('mark_webhook_event_processed', {
      p_provider: PROVIDER,
      p_provider_event_id: webhookId,
      p_expected_processing_attempt: claimToken,
    })
    if (processedError) {
      console.error('[payments.webhook.peach_banv] mark_webhook_event_processed failed', { processedError })
      return NextResponse.json({ error: 'Could not finalize webhook processing' }, { status: 500 })
    }
    logIfLostClaim('mark_webhook_event_processed', processedResult)

    return NextResponse.json({ status: 'received', applied_to_destination: result.appliedToDestination })
  } catch (err) {
    const sanitizedError = (err instanceof Error ? err.message : 'unknown error').slice(0, 500)
    const { data: errorMarkResult } = await admin.rpc('mark_webhook_event_error', {
      p_provider: PROVIDER,
      p_provider_event_id: webhookId,
      p_expected_processing_attempt: claimToken,
      p_last_error: sanitizedError,
    })
    logIfLostClaim('mark_webhook_event_error', errorMarkResult)
    console.error('[payments.webhook.peach_banv] processing failed transiently', { reason: sanitizedError })
    return NextResponse.json({ error: 'Could not process webhook event' }, { status: 503 })
  }
}

function safeParseForAudit(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody)
  } catch {
    return { raw: rawBody.slice(0, 2000) }
  }
}

function logIfLostClaim(step: string, markResult: unknown): void {
  const outcome = markResult && typeof markResult === 'object' ? (markResult as Record<string, unknown>).outcome : undefined
  if (outcome === 'lost_claim') {
    console.error(`[payments.webhook.peach_banv] ${step} reported lost_claim -- a newer claim already owns this event, no action taken`)
  }
}
