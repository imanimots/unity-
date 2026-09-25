import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getPaymentProvider, listRegisteredProviders } from '@/lib/payments/registry'
import { reconcileProviderEvent, reconcileOrchestrationPayment, type NormalizedPaymentEvent } from '@/lib/payments/orchestrator'
import { readBoundedRequestBody, ORCHESTRATION_WEBHOOK_BODY_LIMIT_BYTES } from '@/lib/payments/webhook-body-reader'
import {
  requireOrchestrationWebhookConfig,
  OrchestrationWebhookConfigurationError,
  ORCHESTRATION_WEBHOOK_SECRET_HEADER,
  ORCHESTRATION_WEBHOOK_SIGNATURE_HEADER,
} from '@/lib/payments/providers/orchestration/webhook-config'
import { verifyOrchestrationWebhook } from '@/lib/payments/providers/orchestration/webhook-auth'
import { parseOrchestrationWebhookEnvelope, isRefundEventType, MalformedOrchestrationWebhookError, type OrchestrationWebhookEnvelope } from '@/lib/payments/providers/orchestration/webhook-envelope'

interface RouteParams {
  params: Promise<{ provider: string }>
}

/**
 * The webhook claim lease's staleness threshold (P5D-B) -- application
 * layer only, never baked into SQL (see claim_webhook_event_processing's
 * own comment, unchanged). 30 seconds: well above the sub-5-second
 * response-budget target this route is held to (Peach's own confirmed
 * "2XX within 5 seconds" deadline -- 6x headroom for a legitimately slow
 * but still-working attempt), and comfortably under Peach's confirmed
 * first-retry mark (1 minute) so a genuinely abandoned claim is already
 * reclaimable by that very first redelivery, not a later one.
 */
const ORCHESTRATION_WEBHOOK_STALE_LEASE_SECONDS = 30

/**
 * POST /api/payments/webhooks/[provider] -- generic webhook intake.
 *
 * P5D-B dispatches on whether a delivery carries either Orchestration
 * auth artifact (the custom secret header or the HMAC signature header)
 * for the `peach` provider specifically: if so, it's handled by the
 * dedicated Orchestration pipeline below (dual-layer auth, native
 * envelope, crash-safe inbox claim, shared reconciliation). Everything
 * else -- `mock`, and a `peach` delivery carrying neither Orchestration
 * header (i.e. a classic Checkout/OPPWA delivery) -- falls through to
 * the original generic pipeline, completely unchanged: verifies via
 * that provider's own verifyWebhook(), records via record_webhook_event(),
 * normalizes the small synthetic `{event_id, type, booking_id}` shape,
 * and calls reconcileProviderEvent(). This is a deliberate isolation
 * boundary, not an oversight -- see docs/FINANCIAL_ORCHESTRATION.md and
 * the P5D-B phase report's own "classic Peach regression" section.
 *
 * The body is read once, bounded, at the top -- before any parsing or
 * authentication, and before either pipeline runs -- so both share the
 * exact same raw bytes (required for HMAC verification) and neither can
 * accidentally re-read an already-consumed request stream.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { provider: providerName } = await params

  if (!listRegisteredProviders().includes(providerName)) {
    return NextResponse.json({ error: 'Unknown payment provider' }, { status: 404 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Payment storage is not configured' }, { status: 503 })
  }

  const bodyResult = await readBoundedRequestBody(request, ORCHESTRATION_WEBHOOK_BODY_LIMIT_BYTES)
  if (!bodyResult.ok) {
    console.error('[payments.webhook] request body rejected', { providerName, reason: bodyResult.reason })
    return NextResponse.json({ error: 'Request body too large' }, { status: 413 })
  }
  const rawBody = bodyResult.body

  const headers: Record<string, string | null> = {}
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value
  })

  const { createClient: createServiceClient } = await import('@supabase/supabase-js')
  const admin = createServiceClient(url, serviceKey)

  const looksLikeOrchestrationDelivery =
    providerName === 'peach' && (headers[ORCHESTRATION_WEBHOOK_SECRET_HEADER] != null || headers[ORCHESTRATION_WEBHOOK_SIGNATURE_HEADER] != null)

  if (looksLikeOrchestrationDelivery) {
    return handleOrchestrationWebhook(admin, providerName, rawBody, headers)
  }

  return handleGenericWebhook(admin, providerName, rawBody, headers)
}

/**
 * Original generic pipeline (Phase 2C / classic Peach / MockProvider) --
 * byte-for-byte unchanged in behavior from before P5D-B, only extracted
 * into its own function so POST() can dispatch to it. See the module
 * comment above for why this path still exists.
 */
async function handleGenericWebhook(admin: SupabaseClient, providerName: string, rawBody: string, headers: Record<string, string | null>) {
  let verification
  try {
    const provider = getPaymentProvider(providerName)
    verification = await provider.verifyWebhook({ rawBody, headers })
  } catch (err) {
    // A provider stub (e.g. Peach, not implemented yet) throwing here is
    // expected and safe -- log and reject, never fall through as if the
    // webhook were valid.
    console.error('[payments.webhook] provider verification error', { providerName, err })
    return NextResponse.json({ error: 'Webhook verification failed' }, { status: 501 })
  }

  if (!verification.valid || !verification.providerEventId) {
    // Still recorded, with signature_valid=false, for audit -- an
    // invalid-signature webhook is itself a security-relevant event, not
    // something to silently drop.
    await admin.rpc('record_webhook_event', {
      p_provider: providerName,
      p_provider_event_id: verification.providerEventId ?? `invalid_${Date.now()}`,
      p_signature_valid: false,
      p_payload: safeParseForAudit(rawBody),
    })
    return NextResponse.json({ error: 'Invalid webhook signature' }, { status: 401 })
  }

  const { data, error } = await admin.rpc('record_webhook_event', {
    p_provider: providerName,
    p_provider_event_id: verification.providerEventId,
    p_signature_valid: true,
    p_payload: verification.payload,
  })

  if (error) {
    console.error('[payments.webhook] record error', { providerName, error })
    return NextResponse.json({ error: 'Could not record webhook event' }, { status: 500 })
  }

  if (data?.is_duplicate) {
    return NextResponse.json({ status: 'duplicate_ignored' })
  }

  const normalized = normalizeEvent(verification.providerEventId, verification.payload)
  if (normalized) {
    const reconciliation = await reconcileProviderEvent({ admin, providerName }, normalized)
    return NextResponse.json({ status: 'received', reconciliation })
  }

  return NextResponse.json({ status: 'received' })
}

function safeParseForAudit(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody)
  } catch {
    return { raw: rawBody.slice(0, 2000) }
  }
}

/**
 * Only understands the synthetic shape MockProvider tests use --
 * `{event_id, type, booking_id}`. A real Peach mapping (translating
 * Peach's own webhook payload fields into this same normalized shape)
 * is future, out-of-scope work; reconcileProviderEvent itself would not
 * need to change to support it.
 */
function normalizeEvent(eventId: string, payload: unknown): NormalizedPaymentEvent | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as Record<string, unknown>
  if (typeof p.type !== 'string') return null
  return {
    eventId,
    type: p.type,
    bookingId: typeof p.booking_id === 'string' ? p.booking_id : undefined,
  }
}

/**
 * Dedicated Peach Orchestration pipeline (P5D-B). Critical financial
 * work only, kept narrowly bounded, all before the response is sent (no
 * durable post-response worker is proven to exist on this platform --
 * see the phase report's own "five-second response budget" section):
 * authenticate -> parse -> record -> claim -> reconcile -> mark handled
 * -> respond. No email/notification/analytics work happens on this
 * path in this phase -- see the phase report's "downstream hooks"
 * section for the exact reason (unproven idempotency under
 * webhook-retry/force-sync-race conditions).
 */
async function handleOrchestrationWebhook(admin: SupabaseClient, providerName: string, rawBody: string, headers: Record<string, string | null>) {
  let authValid: boolean
  let authReason: string
  try {
    const config = requireOrchestrationWebhookConfig()
    const result = verifyOrchestrationWebhook(rawBody, headers, config)
    authValid = result.valid
    authReason = result.reason
  } catch (err) {
    // Configuration itself missing/partial -- fail closed exactly like
    // an invalid signature, never silently proceed as if the request
    // were trusted.
    authValid = false
    authReason = err instanceof OrchestrationWebhookConfigurationError ? 'webhook authentication is not configured' : 'webhook authentication check failed'
    console.error('[payments.webhook.orchestration] configuration error', { providerName, reason: authReason })
  }

  if (!authValid) {
    console.error('[payments.webhook.orchestration] authentication failed', { providerName, reason: authReason })
    // Never trust event_id from an unauthenticated body. Bounded,
    // sanitized audit evidence only -- a hash+length+reason, never the
    // full attacker-controlled payload, and this identity must never be
    // reused as a normal authenticated event_id (see the distinct
    // "invalid_" prefix, matching the pre-existing classic-path
    // convention in handleGenericWebhook above).
    const bodyHash = createHash('sha256').update(rawBody, 'utf-8').digest('hex')
    try {
      await admin.rpc('record_webhook_event', {
        p_provider: providerName,
        p_provider_event_id: `invalid_${bodyHash.slice(0, 32)}_${Date.now()}`,
        p_signature_valid: false,
        p_payload: { body_sha256: bodyHash, body_length: Buffer.byteLength(rawBody, 'utf-8'), auth_failure_reason: authReason },
      })
    } catch (recordErr) {
      console.error('[payments.webhook.orchestration] failed to record invalid-auth audit', { recordErr })
    }
    return NextResponse.json({ error: 'Invalid webhook authentication' }, { status: 401 })
  }

  let envelope: OrchestrationWebhookEnvelope
  try {
    envelope = parseOrchestrationWebhookEnvelope(rawBody)
  } catch (err) {
    const reason = err instanceof MalformedOrchestrationWebhookError ? err.message : 'malformed webhook envelope'
    console.error('[payments.webhook.orchestration] malformed envelope (authenticated)', { providerName, reason })
    return NextResponse.json({ error: 'Malformed webhook envelope' }, { status: 400 })
  }

  // Authenticated + structurally valid -- record using the NATIVE
  // event_id, never a synthesized identifier (sha256/payment_id+status)
  // for an authenticated Orchestration event.
  const { data: recordResult, error: recordError } = await admin.rpc('record_webhook_event', {
    p_provider: providerName,
    p_provider_event_id: envelope.eventId,
    p_signature_valid: true,
    p_payload: envelope,
  })
  if (recordError) {
    console.error('[payments.webhook.orchestration] record error', { providerName, eventId: envelope.eventId, recordError })
    return NextResponse.json({ error: 'Could not record webhook event' }, { status: 500 })
  }
  void recordResult

  // Never return early solely because a duplicate was detected -- the
  // claim RPC's own eligibility rules (received/error/stale-processing
  // vs processed/ignored/live-lease) are what actually decide whether
  // reconciliation resumes, not the dedup bit alone (this is exactly
  // the crash-window fix P5D-M1/P5D-M1.1 built).
  const { data: claimResult, error: claimError } = await admin.rpc('claim_webhook_event_processing', {
    p_provider: providerName,
    p_provider_event_id: envelope.eventId,
    p_stale_after_seconds: ORCHESTRATION_WEBHOOK_STALE_LEASE_SECONDS,
  })
  if (claimError) {
    console.error('[payments.webhook.orchestration] claim error', { providerName, eventId: envelope.eventId, claimError })
    return NextResponse.json({ error: 'Could not process webhook event' }, { status: 500 })
  }
  if (!claimResult?.claimed) {
    // processed / ignored / a still-live processing lease -- 2xx, no
    // reconciliation re-attempted, no duplicate financial transition.
    return NextResponse.json({ status: 'no_action', processing_status: claimResult?.processing_status })
  }

  // The exact value returned by the claim -- this worker's fencing
  // token. Never re-read a newer processing_attempts and substitute it.
  const claimToken: number = claimResult.processing_attempts

  if (isRefundEventType(envelope.eventType)) {
    // Recognized, never mutated -- P5E owns refund initiation, and no
    // RPC exists yet to transition refunds.status from provider
    // evidence (P5D-A.1's own finding, unchanged). Marking this
    // delivery durably handled (rather than leaving it stuck in
    // 'processing') is itself the correct, deferred-but-complete
    // outcome for this event.
    const { data: markResult } = await admin.rpc('mark_webhook_event_processed', {
      p_provider: providerName,
      p_provider_event_id: envelope.eventId,
      p_expected_processing_attempt: claimToken,
    })
    logIfLostClaim('mark_webhook_event_processed (refund event)', markResult)
    return NextResponse.json({ status: 'deferred', reason: 'refund_event_reconciliation_not_yet_implemented' })
  }

  let reconciliation
  try {
    reconciliation = await reconcileOrchestrationPayment(admin, {
      providerEventId: envelope.eventId,
      providerEventType: envelope.eventType,
      providerTimestamp: envelope.timestamp,
      paymentId: envelope.content.paymentId,
      status: envelope.content.status,
      amountMinorUnits: envelope.content.amountMinorUnits,
      currency: envelope.content.currency,
      metadata: envelope.content.metadata,
      nextAction: envelope.content.nextAction,
      source: 'webhook',
    })
  } catch (err) {
    // Transient infrastructure failure -- mark-error (never overwrites
    // a newer claim; lost_claim is logged, not treated as a further
    // error) and respond non-2xx so Peach's own retry schedule handles
    // recovery.
    const sanitizedError = (err instanceof Error ? err.message : 'unknown reconciliation error').slice(0, 500)
    const { data: errorMarkResult } = await admin.rpc('mark_webhook_event_error', {
      p_provider: providerName,
      p_provider_event_id: envelope.eventId,
      p_expected_processing_attempt: claimToken,
      p_last_error: sanitizedError,
    })
    logIfLostClaim('mark_webhook_event_error', errorMarkResult)
    console.error('[payments.webhook.orchestration] reconciliation failed transiently', { providerName, eventId: envelope.eventId, reason: sanitizedError })
    return NextResponse.json({ error: 'Could not reconcile payment' }, { status: 503 })
  }

  const { data: processedResult, error: processedError } = await admin.rpc('mark_webhook_event_processed', {
    p_provider: providerName,
    p_provider_event_id: envelope.eventId,
    p_expected_processing_attempt: claimToken,
  })
  if (processedError) {
    console.error('[payments.webhook.orchestration] mark_webhook_event_processed failed', { providerName, eventId: envelope.eventId, processedError })
    return NextResponse.json({ error: 'Could not finalize webhook processing' }, { status: 500 })
  }
  logIfLostClaim('mark_webhook_event_processed', processedResult)

  return NextResponse.json({ status: 'received', reconciliation })
}

/**
 * A `lost_claim` outcome from a mark-* call means a newer worker has
 * already reclaimed this event -- informational only. This worker must
 * never attempt to steal it back or treat it as an error of its own; it
 * simply stops here and lets the newer claim finish.
 */
function logIfLostClaim(step: string, markResult: unknown): void {
  const outcome = markResult && typeof markResult === 'object' ? (markResult as Record<string, unknown>).outcome : undefined
  if (outcome === 'lost_claim') {
    console.error(`[payments.webhook.orchestration] ${step} reported lost_claim -- a newer claim already owns this event, no action taken`)
  }
}
