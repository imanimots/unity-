import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { adminAffiliateOverrideSchema } from '@/lib/affiliate/validation'
import { mapAffiliateRpcError } from '@/lib/affiliate/rpc-errors'
import { computeCommissionIdAndReasonHash, checkIdempotentReplay } from '@/lib/affiliate/idempotency'

interface RouteParams {
  params: Promise<{ id: string }>
}

/** POST /api/admin/affiliate-commissions/[id]/mark-paid -- records a legitimate manual payout. Reason mandatory. */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: commissionId } = await params
  if (!isValidUuid(commissionId)) {
    return NextResponse.json({ error: 'Invalid commission id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:affiliate-commissions:mark-paid')
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
  const parsed = adminAffiliateOverrideSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'A reason is required', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const adminId = gate.requester.userId

  if (parsed.data.idempotency_key) {
    const hash = computeCommissionIdAndReasonHash(commissionId, parsed.data.reason ?? '')
    const replay = await checkIdempotentReplay(admin, adminId, 'mark_affiliate_commission_paid_manually', parsed.data.idempotency_key, hash)
    if (replay.status === 'replay') return NextResponse.json(replay.result)
    if (replay.status === 'conflict') {
      const mapped = mapAffiliateRpcError('idempotency key already used with a different request')
      return NextResponse.json({ error: mapped.error }, { status: mapped.status })
    }
  }

  const { data, error } = await admin.rpc('mark_affiliate_commission_paid_manually', {
    p_admin_id: adminId,
    p_commission_id: commissionId,
    p_reason: parsed.data.reason,
    p_idempotency_key: parsed.data.idempotency_key ?? null,
  })

  if (error) {
    console.error('[admin.affiliate-commissions.mark-paid] RPC error', { adminId, commissionId, error })
    const mapped = mapAffiliateRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }

  return NextResponse.json(data)
}
