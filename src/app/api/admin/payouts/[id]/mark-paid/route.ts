import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { adminMarkPaidSchema } from '@/lib/payouts/validation'
import { mapPayoutRpcError } from '@/lib/payouts/rpc-errors'
import { computeMarkPaidHash, checkIdempotentReplay } from '@/lib/payouts/idempotency'
import { notifyMerchantPayoutEvent } from '@/lib/payouts/notify'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/admin/payouts/[id]/mark-paid -- processing -> paid only.
 * Requires an explicit confirmManualPayment: true, a safe payout
 * reference, and a payout method from the approved enum
 * ('manual' | 'mock_validation') -- the browser cannot submit any value
 * outside that set. No banking details are ever accepted or stored.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: payoutId } = await params
  if (!isValidUuid(payoutId)) {
    return NextResponse.json({ error: 'Invalid payout id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:payouts:mark-paid')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Payout storage is not configured' }, { status: 503 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  const parsed = adminMarkPaidSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const adminId = gate.requester.userId

  if (parsed.data.idempotency_key) {
    const hash = computeMarkPaidHash(payoutId, parsed.data.payoutReference, parsed.data.payoutMethod)
    const replay = await checkIdempotentReplay(admin, adminId, 'mark_payout_paid', parsed.data.idempotency_key, hash)
    if (replay.status === 'replay') return NextResponse.json(replay.result)
    if (replay.status === 'conflict') {
      const mapped = mapPayoutRpcError('idempotency key already used with a different request')
      return NextResponse.json({ error: mapped.error }, { status: mapped.status })
    }
  }

  const { data, error } = await admin.rpc('mark_payout_paid', {
    p_admin_id: adminId,
    p_payout_id: payoutId,
    p_payout_reference: parsed.data.payoutReference,
    p_payout_method: parsed.data.payoutMethod,
    p_confirm_manual_payment: parsed.data.confirmManualPayment,
    p_reason: parsed.data.reason ?? null,
    p_idempotency_key: parsed.data.idempotency_key ?? null,
  })

  if (error) {
    console.error('[admin.payouts.mark-paid] RPC error', { adminId, payoutId, error })
    const mapped = mapPayoutRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }

  try {
    await notifyMerchantPayoutEvent(admin, payoutId, 'merchant_payout.paid', parsed.data.idempotency_key)
  } catch (emailErr) {
    console.error('[admin.payouts.mark-paid] email dispatch failed', { payoutId, emailErr })
  }

  return NextResponse.json(data)
}
