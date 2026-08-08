import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { getAdminUnityCommissionDetail } from '@/lib/admin/commissions-service'

interface RouteParams {
  params: Promise<{ id: string }>
}

/** GET /api/admin/commissions/[id] -- real data, read-only detail. */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { id: commissionId } = await params
  if (!isValidUuid(commissionId)) {
    return NextResponse.json({ error: 'Invalid commission id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:commissions:detail')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Commission storage is not configured' }, { status: 503 })
  }

  try {
    const detail = await getAdminUnityCommissionDetail(admin, commissionId)
    if (!detail) {
      return NextResponse.json({ error: 'Commission not found' }, { status: 404 })
    }
    return NextResponse.json(detail)
  } catch (err) {
    console.error('[admin.commissions.detail] error', { commissionId, err })
    return NextResponse.json({ error: 'Could not load commission' }, { status: 500 })
  }
}
