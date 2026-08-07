import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { adminMarkProcessingSchema } from '@/lib/payouts/validation'
import { mapPayoutRpcError } from '@/lib/payouts/rpc-errors'
import { computeMarkProcessingHash, checkIdempotentReplay } from '@/lib/payouts/idempotency'
import { notifyMerchantPayoutEvent } from '@/lib/payouts/notify'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/admin/payouts/[id]/mark-processing -- pending -> processing
 * only. Full eligibility is re-validated inside the RPC, never trusted
 * from any prior read. No payout provider is ever called here -- this
 * only records that Unity has begun processing the payout manually.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: payoutId } = await params
  if (!isValidUuid(payoutId)) {
    return NextResponse.json({ error: 'Invalid payout id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:payouts:mark-processing')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Payout storage is not configured' }, { status: 503 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    body = {}
  }
  const parsed = adminMarkProcessingSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const adminId = gate.requester.userId

  if (parsed.data.idempotency_key) {
    const hash = computeMarkProcessingHash(payoutId, parsed.data.reason ?? null)
    const replay = await checkIdempotentReplay(admin, adminId, 'mark_payout_processing', parsed.data.idempotency_key, hash)
    if (replay.status === 'replay') return NextResponse.json(replay.result)
    if (replay.status === 'conflict') {
      const mapped = mapPayoutRpcError('idempotency key already used with a different request')
      return NextResponse.json({ error: mapped.error }, { status: mapped.status })
    }
  }

  const { data, error } = await admin.rpc('mark_payout_processing', {
    p_admin_id: adminId,
    p_payout_id: payoutId,
    p_reason: parsed.data.reason ?? null,
    p_idempotency_key: parsed.data.idempotency_key ?? null,
  })

  if (error) {
    console.error('[admin.payouts.mark-processing] RPC error', { adminId, payoutId, error })
    const mapped = mapPayoutRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }

  try {
    await notifyMerchantPayoutEvent(admin, payoutId, 'merchant_payout.processing', parsed.data.idempotency_key)
  } catch (emailErr) {
    console.error('[admin.payouts.mark-processing] email dispatch failed', { payoutId, emailErr })
  }

  return NextResponse.json(data)
}
