import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { adminCommissionAdjustmentSchema } from '@/lib/commissions/validation'
import { mapCommissionRpcError } from '@/lib/commissions/rpc-errors'
import { computeAdjustmentHash, checkIdempotentReplay } from '@/lib/commissions/idempotency'
import { notifyMerchantOfUnityCommission } from '@/lib/commissions/notify'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/admin/commissions/[id]/adjust -- append-only correction.
 * Never edits the original commission's base/rate/plan-snapshot/amount
 * -- this is the only way to record a signed correction, moving the
 * commission to 'adjusted'.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: commissionId } = await params
  if (!isValidUuid(commissionId)) {
    return NextResponse.json({ error: 'Invalid commission id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:commissions:adjust')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Commission storage is not configured' }, { status: 503 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  const parsed = adminCommissionAdjustmentSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid fields', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const adminId = gate.requester.userId

  if (parsed.data.idempotency_key) {
    const hash = computeAdjustmentHash(commissionId, parsed.data.amount, parsed.data.reason)
    const replay = await checkIdempotentReplay(admin, adminId, 'create_unity_commission_adjustment', parsed.data.idempotency_key, hash)
    if (replay.status === 'replay') return NextResponse.json(replay.result)
    if (replay.status === 'conflict') {
      const mapped = mapCommissionRpcError('idempotency key already used with a different request')
      return NextResponse.json({ error: mapped.error }, { status: mapped.status })
    }
  }

  const { data, error } = await admin.rpc('create_unity_commission_adjustment', {
    p_actor_type: 'admin',
    p_actor_id: adminId,
    p_commission_id: commissionId,
    p_amount: parsed.data.amount,
    p_reason: parsed.data.reason,
    p_idempotency_key: parsed.data.idempotency_key ?? null,
  })

  if (error) {
    console.error('[admin.commissions.adjust] RPC error', { adminId, commissionId, error })
    const mapped = mapCommissionRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }

  try {
    await notifyMerchantOfUnityCommission(admin, commissionId, 'unity_commission.adjusted', 'unity-commission-adjusted', {
      adjustmentAmount: `R${parsed.data.amount.toFixed(2)}`,
    })
  } catch (emailErr) {
    console.error('[admin.commissions.adjust] email dispatch failed', { commissionId, emailErr })
  }

  return NextResponse.json(data)
}
