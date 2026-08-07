import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { adminRetryPayoutSchema } from '@/lib/payouts/validation'
import { mapPayoutRpcError } from '@/lib/payouts/rpc-errors'
import { computeRetryPayoutHash, checkIdempotentReplay } from '@/lib/payouts/idempotency'
import { notifyMerchantPayoutEvent } from '@/lib/payouts/notify'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/admin/payouts/[id]/retry -- failed -> processing on the
 * SAME row, never a new payout. Full eligibility is re-validated inside
 * the RPC. A mandatory reason is required.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: payoutId } = await params
  if (!isValidUuid(payoutId)) {
    return NextResponse.json({ error: 'Invalid payout id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:payouts:retry')
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
  const parsed = adminRetryPayoutSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'A reason is required', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const adminId = gate.requester.userId

  if (parsed.data.idempotency_key) {
    const hash = computeRetryPayoutHash(payoutId, parsed.data.reason)
    const replay = await checkIdempotentReplay(admin, adminId, 'retry_payout', parsed.data.idempotency_key, hash)
    if (replay.status === 'replay') return NextResponse.json(replay.result)
    if (replay.status === 'conflict') {
      const mapped = mapPayoutRpcError('idempotency key already used with a different request')
      return NextResponse.json({ error: mapped.error }, { status: mapped.status })
    }
  }

  const { data, error } = await admin.rpc('retry_payout', {
    p_admin_id: adminId,
    p_payout_id: payoutId,
    p_reason: parsed.data.reason,
    p_idempotency_key: parsed.data.idempotency_key ?? null,
  })

  if (error) {
    console.error('[admin.payouts.retry] RPC error', { adminId, payoutId, error })
    const mapped = mapPayoutRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }

  try {
    await notifyMerchantPayoutEvent(admin, payoutId, 'merchant_payout.retry_started', parsed.data.idempotency_key)
  } catch (emailErr) {
    console.error('[admin.payouts.retry] email dispatch failed', { payoutId, emailErr })
  }

  return NextResponse.json(data)
}
