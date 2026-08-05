import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { openDisputeSchema } from '@/lib/disputes/validation'
import { mapDisputeRpcError } from '@/lib/disputes/rpc-errors'
import { computeOpenDisputeHash, checkIdempotentReplay } from '@/lib/disputes/idempotency'
import { sendTemplate, loadDisputeEmailContext } from '@/lib/email'

/**
 * POST /api/disputes -- open a dispute against a booking, order, or
 * barter agreement (exactly one, validated by openDisputeSchema and
 * again by open_dispute() itself). The raiser is always requester.userId,
 * never client-supplied -- open_dispute() re-validates party membership
 * server-side regardless.
 *
 * GET /api/disputes -- the caller's own disputes (as raiser or the
 * transaction's other party), scoped by "disputes: parties read" RLS,
 * same pattern as GET /api/barter.
 */
export async function POST(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Dispute storage is not configured' }, { status: 503 })
  }

  const rate = checkRateLimit(`disputes:open:${getClientKey(request)}`, 10, 60_000)
  if (!rate.allowed) {
    return NextResponse.json({ error: 'Too many requests — please slow down' }, { status: 429 })
  }

  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in to open a dispute' }, { status: 401 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const parsed = openDisputeSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid dispute', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  try {
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    const admin = createServiceClient(url, serviceKey)

    if (parsed.data.idempotency_key) {
      const hash = computeOpenDisputeHash(
        parsed.data.booking_id,
        parsed.data.order_id,
        parsed.data.barter_agreement_id,
        parsed.data.title,
        parsed.data.reason,
        parsed.data.description,
        parsed.data.requested_resolution
      )
      const replay = await checkIdempotentReplay(admin, requester.userId, 'open_dispute', parsed.data.idempotency_key, hash)
      if (replay.status === 'replay') return NextResponse.json(replay.result, { status: 201 })
      if (replay.status === 'conflict') {
        const mapped = mapDisputeRpcError('idempotency key already used with a different request')
        return NextResponse.json({ error: mapped.error }, { status: mapped.status })
      }
    }

    const { data, error } = await admin.rpc('open_dispute', {
      p_raiser_user_id: requester.userId,
      p_booking_id: parsed.data.booking_id ?? null,
      p_order_id: parsed.data.order_id ?? null,
      p_barter_agreement_id: parsed.data.barter_agreement_id ?? null,
      p_title: parsed.data.title,
      p_reason: parsed.data.reason ?? null,
      p_description: parsed.data.description,
      p_requested_resolution: parsed.data.requested_resolution,
      p_idempotency_key: parsed.data.idempotency_key ?? null,
    })

    if (error) {
      console.error('[disputes.open] RPC error', { userId: requester.userId, error })
      const mapped = mapDisputeRpcError(error.message)
      return NextResponse.json({ error: mapped.error }, { status: mapped.status })
    }

    try {
      const ctx = await loadDisputeEmailContext(admin, data.dispute_id)
      // email_deliveries.related_entity_type has no 'dispute' value (only
      // booking/listing/identity_verification/order/barter_agreement,
      // widened in Phase 1) -- every dispute maps 1:1 to exactly one
      // transaction, so dispute emails reference that transaction
      // directly rather than needing yet another schema widening.
      const relatedEntityType = parsed.data.booking_id ? 'booking' : parsed.data.order_id ? 'order' : 'barter_agreement'
      const relatedEntityId = parsed.data.booking_id ?? parsed.data.order_id ?? parsed.data.barter_agreement_id!
      if (ctx) {
        await sendTemplate(admin, {
          eventType: 'dispute.opened',
          templateId: 'dispute-opened-raiser',
          recipientUserId: ctx.raiserId,
          relatedEntityType,
          relatedEntityId,
          occurrenceKey: `dispute-${ctx.disputeId}-raiser`,
          vars: { raiserName: ctx.raiserName, title: ctx.title, transactionReference: ctx.transactionReference },
        })
        await sendTemplate(admin, {
          eventType: 'dispute.opened',
          templateId: 'dispute-opened-respondent',
          recipientUserId: ctx.respondentId,
          relatedEntityType,
          relatedEntityId,
          occurrenceKey: `dispute-${ctx.disputeId}-respondent`,
          vars: { respondentName: ctx.respondentName, raiserName: ctx.raiserName, title: ctx.title, transactionReference: ctx.transactionReference },
        })
      }
    } catch (emailErr) {
      console.error('[disputes.open] email dispatch failed', { userId: requester.userId, emailErr })
    }

    return NextResponse.json(data, { status: 201 })
  } catch (err) {
    console.error('[disputes.open] unexpected error', { userId: requester.userId, err })
    return NextResponse.json({ error: 'Could not open your dispute — please try again' }, { status: 500 })
  }
}

export async function GET() {
  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
  }

  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  if (!supabase) {
    return NextResponse.json({ error: 'Dispute storage is not configured' }, { status: 503 })
  }

  // RLS ("disputes: parties read") scopes this to rows where the caller
  // is raised_by, or a party on the referenced booking/order/barter
  // agreement -- no explicit filter needed.
  const { data, error } = await supabase.from('disputes').select('*').order('created_at', { ascending: false })

  if (error) {
    console.error('[disputes.list] error', { userId: requester.userId, error })
    return NextResponse.json({ error: 'Could not load disputes' }, { status: 500 })
  }

  return NextResponse.json({ disputes: data ?? [] })
}
