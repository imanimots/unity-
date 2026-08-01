import { NextRequest, NextResponse } from 'next/server'
import { getPaymentProvider, listRegisteredProviders } from '@/lib/payments/registry'
import { reconcileProviderEvent, type NormalizedPaymentEvent } from '@/lib/payments/orchestrator'

interface RouteParams {
  params: Promise<{ provider: string }>
}

/**
 * POST /api/payments/webhooks/[provider] -- generic webhook intake.
 *
 * No real provider calls this route yet (Phase 2C builds the framework,
 * not a live Peach integration). What this route does today:
 *   1. isolates providers from each other (the [provider] segment scopes
 *      everything -- a "peach" webhook can never be processed as a
 *      "mock" event or vice versa)
 *   2. verifies the signature via that provider's own verifyWebhook()
 *      (never trusts payload content over an unverified signature)
 *   3. records every webhook -- valid or not -- for audit purposes via
 *      record_webhook_event(), whose (provider, provider_event_id)
 *      unique constraint is the actual duplicate-event/replay defense
 *   4. returns 200 for a duplicate without reprocessing anything
 *      (replay safety -- a provider retrying an already-seen webhook
 *      must never cause a second side effect)
 *   5. normalizes a new, valid event into the small shape
 *      reconcileProviderEvent() understands, and calls it
 *
 * No business orchestration lives in this route -- reconcileProviderEvent
 * (src/lib/payments/orchestrator/reconcile-provider-event.ts) is the only
 * orchestration entry point it calls, and that function itself does
 * nothing beyond resuming a financial_workflows row already recorded as
 * failed_retryable. There is no real provider event shape to normalize
 * from yet (Peach mappings are out of scope this pass) -- a synthetic
 * `{event_id, type, booking_id}` payload shape is accepted so the intake
 * -> dedup -> normalize -> reconcile -> respond plumbing is fully
 * testable end to end today. See docs/FINANCIAL_ORCHESTRATION.md.
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

  const rawBody = await request.text()
  const headers: Record<string, string | null> = {}
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value
  })

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

  const { createClient: createServiceClient } = await import('@supabase/supabase-js')
  const admin = createServiceClient(url, serviceKey)

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
