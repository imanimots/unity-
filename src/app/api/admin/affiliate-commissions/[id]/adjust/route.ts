import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { adminAffiliateAdjustmentSchema } from '@/lib/affiliate/validation'
import { mapAffiliateRpcError } from '@/lib/affiliate/rpc-errors'
import { computeAdjustmentHash, checkIdempotentReplay } from '@/lib/affiliate/idempotency'
import { notifyAffiliateOfCommission } from '@/lib/affiliate/notify'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/admin/affiliate-commissions/[id]/adjust -- append-only
 * correction. Never edits the original commission's amount/rate/
 * affiliate/customer/merchant/listing/payment_id -- this is the only
 * way to record a signed correction against a commission.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: commissionId } = await params
  if (!isValidUuid(commissionId)) {
    return NextResponse.json({ error: 'Invalid commission id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:affiliate-commissions:adjust')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Affiliate storage is not configured' }, { status: 503 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  const parsed = adminAffiliateAdjustmentSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid fields', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const adminId = gate.requester.userId

  if (parsed.data.idempotency_key) {
    const hash = computeAdjustmentHash(commissionId, parsed.data.amount, parsed.data.reason)
    const replay = await checkIdempotentReplay(admin, adminId, 'create_affiliate_commission_adjustment', parsed.data.idempotency_key, hash)
    if (replay.status === 'replay') return NextResponse.json(replay.result)
    if (replay.status === 'conflict') {
      const mapped = mapAffiliateRpcError('idempotency key already used with a different request')
      return NextResponse.json({ error: mapped.error }, { status: mapped.status })
    }
  }

  const { data, error } = await admin.rpc('create_affiliate_commission_adjustment', {
    p_admin_id: adminId,
    p_commission_id: commissionId,
    p_amount: parsed.data.amount,
    p_reason: parsed.data.reason,
    p_idempotency_key: parsed.data.idempotency_key ?? null,
  })

  if (error) {
    console.error('[admin.affiliate-commissions.adjust] RPC error', { adminId, commissionId, error })
    const mapped = mapAffiliateRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }

  try {
    await notifyAffiliateOfCommission(admin, commissionId, 'affiliate.adjustment_created', 'affiliate-adjustment-created', {
      adjustmentAmount: `R${parsed.data.amount.toFixed(2)}`,
    })
  } catch (emailErr) {
    console.error('[admin.affiliate-commissions.adjust] email dispatch failed', { commissionId, emailErr })
  }

  return NextResponse.json(data)
}
