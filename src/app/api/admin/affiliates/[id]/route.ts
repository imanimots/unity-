import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { getAdminAffiliateDetail } from '@/lib/admin/affiliate-service'

interface RouteParams {
  params: Promise<{ id: string }>
}

/** GET /api/admin/affiliates/[id] -- one affiliate's attributions + commissions, admin-only, read-only. */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { id: affiliateId } = await params
  if (!isValidUuid(affiliateId)) {
    return NextResponse.json({ error: 'Invalid affiliate id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:affiliates:detail')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Affiliate storage is not configured' }, { status: 503 })
  }

  const detail = await getAdminAffiliateDetail(admin, affiliateId)
  if (!detail) {
    return NextResponse.json({ error: 'Affiliate not found' }, { status: 404 })
  }

  return NextResponse.json(detail)
}
