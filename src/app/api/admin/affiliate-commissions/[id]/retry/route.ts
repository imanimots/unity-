import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { adminAffiliateOverrideSchema } from '@/lib/affiliate/validation'
import { mapAffiliateRpcError } from '@/lib/affiliate/rpc-errors'
import { computeCommissionIdAndReasonHash, checkIdempotentReplay } from '@/lib/affiliate/idempotency'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/admin/affiliate-commissions/[id]/retry -- retries a failed
 * payout (failed -> payout_queued, picked up by the next automatic
 * process-payouts sweep). Scoped to an existing commission row, so
 * "retry qualification" for a payment that never produced a commission
 * at all (the "successful eligible payment missing commission"
 * exception) is a separate concern with no commission id to route on --
 * qualify_sale_affiliate_commission()/qualify_rental_payment_affiliate_
 * commission() are themselves safely re-callable directly from the
 * relevant exception's own linked route once the underlying payment is
 * identified.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: commissionId } = await params
  if (!isValidUuid(commissionId)) {
    return NextResponse.json({ error: 'Invalid commission id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:affiliate-commissions:retry')
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
    const replay = await checkIdempotentReplay(admin, adminId, 'retry_affiliate_payout', parsed.data.idempotency_key, hash)
    if (replay.status === 'replay') return NextResponse.json(replay.result)
    if (replay.status === 'conflict') {
      const mapped = mapAffiliateRpcError('idempotency key already used with a different request')
      return NextResponse.json({ error: mapped.error }, { status: mapped.status })
    }
  }

  const { data, error } = await admin.rpc('retry_affiliate_payout', {
    p_admin_id: adminId,
    p_commission_id: commissionId,
    p_reason: parsed.data.reason,
    p_idempotency_key: parsed.data.idempotency_key ?? null,
  })

  if (error) {
    console.error('[admin.affiliate-commissions.retry] RPC error', { adminId, commissionId, error })
    const mapped = mapAffiliateRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }

  return NextResponse.json(data)
}
