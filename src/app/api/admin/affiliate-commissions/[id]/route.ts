import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { getAdminAffiliateCommissionDetail } from '@/lib/admin/affiliate-service'

interface RouteParams {
  params: Promise<{ id: string }>
}

/** GET /api/admin/affiliate-commissions/[id] -- full detail, admin-only, read-only. */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { id: commissionId } = await params
  if (!isValidUuid(commissionId)) {
    return NextResponse.json({ error: 'Invalid commission id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:affiliate-commissions:detail')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Affiliate storage is not configured' }, { status: 503 })
  }

  const detail = await getAdminAffiliateCommissionDetail(admin, commissionId)
  if (!detail) {
    return NextResponse.json({ error: 'Commission not found' }, { status: 404 })
  }

  return NextResponse.json(detail)
}
