import { NextRequest, NextResponse } from 'next/server'
import { getEscrowProvider, listRegisteredEscrowProviders } from '@/lib/escrow/registry'
import { isEscrowEnabled } from '@/lib/escrow/config'

interface RouteParams {
  params: Promise<{ provider: string }>
}

/**
 * POST /api/escrow/webhooks/[provider] -- generic escrow webhook intake.
 * Mirrors src/app/api/payments/webhooks/[provider]/route.ts's exact
 * shape (isolate providers via the URL segment, verify signature before
 * trusting content, record every event -- valid or not -- via
 * record_escrow_webhook_event(), return 200 without reprocessing on
 * duplicate). A SEPARATE route/table from the payments webhook intake --
 * escrow is a distinct financial concern from payment charge processing.
 *
 * No real provider calls this route yet. TradeSafe is a proposed
 * provider only (UnsupportedTradeSafeProvider throws on verifyWebhook()
 * just like every other method) -- this route exists so the intake ->
 * dedup -> audit plumbing is fully testable against MockEscrowProvider
 * today, ready for a real adapter later without changing this file.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { provider: providerName } = await params

  if (!isEscrowEnabled()) {
    return NextResponse.json({ error: 'Escrow is not enabled' }, { status: 503 })
  }

  if (!listRegisteredEscrowProviders().includes(providerName)) {
    return NextResponse.json({ error: 'Unknown escrow provider' }, { status: 404 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Escrow storage is not configured' }, { status: 503 })
  }

  const rawBody = await request.text()
  const headers: Record<string, string | null> = {}
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value
  })

  let verification
  try {
    const provider = getEscrowProvider(providerName)
    verification = await provider.verifyWebhook({ rawBody, headers })
  } catch (err) {
    // A provider stub (TradeSafe, not implemented yet) throwing here is
    // expected and safe -- log and reject, never fall through as if the
    // webhook were valid.
    console.error('[escrow.webhook] provider verification error', { providerName, err })
    return NextResponse.json({ error: 'Webhook verification failed' }, { status: 501 })
  }

  const { createClient: createServiceClient } = await import('@supabase/supabase-js')
  const admin = createServiceClient(url, serviceKey)

  if (!verification.valid || !verification.providerEventId) {
    // Still recorded, with signature_valid=false, for audit.
    await admin.rpc('record_escrow_webhook_event', {
      p_provider: providerName,
      p_provider_event_id: verification.providerEventId ?? `invalid_${Date.now()}`,
      p_signature_valid: false,
      p_payload: safeParseForAudit(rawBody),
    })
    return NextResponse.json({ error: 'Invalid webhook signature' }, { status: 401 })
  }

  const { data, error } = await admin.rpc('record_escrow_webhook_event', {
    p_provider: providerName,
    p_provider_event_id: verification.providerEventId,
    p_signature_valid: true,
    p_payload: verification.payload,
  })

  if (error) {
    console.error('[escrow.webhook] record error', { providerName, error })
    return NextResponse.json({ error: 'Could not record webhook event' }, { status: 500 })
  }

  if (data?.is_duplicate) {
    return NextResponse.json({ status: 'duplicate_ignored' })
  }

  // No business reconciliation is wired from this route yet -- the mock
  // provider's own fund/release/refund calls already report their
  // outcome synchronously to the orchestrator, so there is no async
  // event to reconcile against today. A real provider's webhook mapping
  // (e.g. resuming a pending funding after an async confirmation) is
  // future, out-of-scope work, exactly like reconcileProviderEvent()'s
  // own header comment states for payments.
  return NextResponse.json({ status: 'received' })
}

function safeParseForAudit(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody)
  } catch {
    return { raw: rawBody.slice(0, 2000) }
  }
}
