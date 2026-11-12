import { NextRequest, NextResponse } from 'next/server'
import { readBoundedRequestBody, ORCHESTRATION_WEBHOOK_BODY_LIMIT_BYTES } from '@/lib/payments/webhook-body-reader'
import { verifyPayoutsWebhookSignature } from '@/lib/payments/providers/peach/payouts-webhook-signature'
import { loadPeachPayoutsConfig } from '@/lib/payments/providers/peach/payouts-config'
import { applyPayoutWebhookPayload } from '@/lib/payments/orchestrator'

/**
 * E33: Peach payout-status-updated webhook intake. Mirrors
 * /api/payments/webhooks/peach-banv/route.ts exactly (same reuse
 * rationale: this is not a generic [provider] payment-webhook delivery,
 * it is payout-execution authority, with its own dedicated signed
 * route reusing the same provider-neutral payment_webhook_events lease
 * RPCs under a new provider value 'peach_payouts').
 *
 * Signature scheme: the same Svix/Standard Webhooks helper E32 already
 * built for BANV (webhook-id/webhook-timestamp/webhook-signature,
 * whsec_ secret) -- confirmed live this phase to be the identical
 * scheme for Payouts' payout-status webhook too.
 */
const PROVIDER = 'peach_payouts'
const STALE_LEASE_SECONDS = 30

export async function POST(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Payment storage is not configured' }, { status: 503 })
  }

  const config = loadPeachPayoutsConfig()
  if (!config || !config.webhookSigningSecret) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const bodyResult = await readBoundedRequestBody(request, ORCHESTRATION_WEBHOOK_BODY_LIMIT_BYTES)
  if (!bodyResult.ok) {
    console.error('[payments.webhook.peach_payouts] request body rejected', { reason: bodyResult.reason })
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
    console.error('[payments.webhook.peach_payouts] authentication failed', { reason: verification.reason })
    try {
      await admin.rpc('record_webhook_event', {
        p_provider: PROVIDER,
        p_provider_event_id: webhookId ?? `invalid_${Date.now()}`,
        p_signature_valid: false,
        p_payload: safeParseForAudit(rawBody),
      })
    } catch (recordErr) {
      console.error('[payments.webhook.peach_payouts] failed to record invalid-auth audit', { recordErr })
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
    console.error('[payments.webhook.peach_payouts] record error', { recordError })
    return NextResponse.json({ error: 'Could not record webhook event' }, { status: 500 })
  }
  void recordResult

  const { data: claimResult, error: claimError } = await admin.rpc('claim_webhook_event_processing', {
    p_provider: PROVIDER,
    p_provider_event_id: webhookId,
    p_stale_after_seconds: STALE_LEASE_SECONDS,
  })
  if (claimError) {
    console.error('[payments.webhook.peach_payouts] claim error', { claimError })
    return NextResponse.json({ error: 'Could not process webhook event' }, { status: 500 })
  }
  if (!claimResult?.claimed) {
    return NextResponse.json({ status: 'no_action', processing_status: claimResult?.processing_status })
  }

  const claimToken: number = claimResult.processing_attempts

  try {
    const result = await applyPayoutWebhookPayload(admin, payload)
    if (!result) {
      const { data: errorMarkResult } = await admin.rpc('mark_webhook_event_error', {
        p_provider: PROVIDER,
        p_provider_event_id: webhookId,
        p_expected_processing_attempt: claimToken,
        p_last_error: 'unrecognized payout webhook payload shape or unknown payoutId',
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
      console.error('[payments.webhook.peach_payouts] mark_webhook_event_processed failed', { processedError })
      return NextResponse.json({ error: 'Could not finalize webhook processing' }, { status: 500 })
    }
    logIfLostClaim('mark_webhook_event_processed', processedResult)

    return NextResponse.json({ status: 'received', domain_transitioned: result.domainTransitioned })
  } catch (err) {
    const sanitizedError = (err instanceof Error ? err.message : 'unknown error').slice(0, 500)
    const { data: errorMarkResult } = await admin.rpc('mark_webhook_event_error', {
      p_provider: PROVIDER,
      p_provider_event_id: webhookId,
      p_expected_processing_attempt: claimToken,
      p_last_error: sanitizedError,
    })
    logIfLostClaim('mark_webhook_event_error', errorMarkResult)
    console.error('[payments.webhook.peach_payouts] processing failed transiently', { reason: sanitizedError })
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
    console.error(`[payments.webhook.peach_payouts] ${step} reported lost_claim -- a newer claim already owns this event, no action taken`)
  }
}
