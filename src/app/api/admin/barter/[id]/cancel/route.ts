import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { adminCancelBarterSchema } from '@/lib/barter/validation'
import { mapBarterRpcError } from '@/lib/barter/rpc-errors'
import { releaseBarterDeposit } from '@/lib/payments/orchestrator'
import { notifyBarterParties } from '@/lib/barter/notify'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/admin/barter/[id]/cancel -- admin-privileged cancellation
 * (Step 11 Phase 4 Part J). Unlike the participant-facing cancel route,
 * this MAY cancel a disputed agreement -- an admin resolving a dispute
 * needs this; a participant bypassing the freeze does not.
 * admin_cancel_barter_agreement() records actor_role='admin' in
 * barter_history -- every admin action is audited, never impersonating
 * a party.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: agreementId } = await params
  if (!isValidUuid(agreementId)) {
    return NextResponse.json({ error: 'Invalid barter agreement id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:barter:cancel')
  if (!gate.ok) return gate.response

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  const parsed = adminCancelBarterSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Barter storage is not configured' }, { status: 503 })
  }

  const { data, error } = await admin.rpc('admin_cancel_barter_agreement', {
    p_admin_id: gate.requester.userId,
    p_agreement_id: agreementId,
    p_reason: parsed.data.reason ?? null,
    p_idempotency_key: parsed.data.idempotency_key ?? null,
  })

  if (error) {
    console.error('[admin.barter.cancel] RPC error', { agreementId, error })
    const mapped = mapBarterRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }

  // Same post-RPC settlement execution as the participant-facing cancel
  // route (Decision 4) -- 'refunded' releases authorised deposits and
  // voids never-attempted pending intents; 'frozen_pending_dispute'
  // (the only possible outcome for a disputed agreement) does nothing.
  if (data?.settlement === 'refunded') {
    const { data: agreementPayments } = await admin.from('payments').select('id, status, payment_type, renter_id').eq('barter_agreement_id', agreementId)
    for (const payment of agreementPayments ?? []) {
      try {
        if (payment.payment_type === 'barter_deposit' && payment.status === 'authorised') {
          await releaseBarterDeposit({ admin }, agreementId, payment.renter_id)
        } else if (payment.status === 'pending') {
          await admin.rpc('transition_payment_status', { p_payment_id: payment.id, p_new_status: 'cancelled', p_actor_type: 'system' })
        }
      } catch (settlementErr) {
        console.error('[admin.barter.cancel] settlement execution failed for a payment', { agreementId, paymentId: payment.id, settlementErr })
      }
    }
  }

  try {
    await notifyBarterParties(admin, agreementId, 'barter.cancelled', 'barter-cancelled', { cancellation_reason: parsed.data.reason ?? '' })
  } catch (emailErr) {
    console.error('[admin.barter.cancel] email dispatch failed', { agreementId, emailErr })
  }

  return NextResponse.json(data)
}
