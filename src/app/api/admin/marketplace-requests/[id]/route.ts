import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { getAdminMarketplaceRequestDetail } from '@/lib/admin/marketplace-requests-service'

interface RouteParams {
  params: Promise<{ id: string }>
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const { id } = await params
  if (!isValidUuid(id)) return NextResponse.json({ error: 'Invalid request id' }, { status: 400 })

  const gate = await requireAdminForRoute(request, 'admin:marketplace-requests:detail')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) return NextResponse.json({ error: 'Marketplace storage is not configured' }, { status: 503 })

  try {
    const detail = await getAdminMarketplaceRequestDetail(admin, id)
    if (!detail) return NextResponse.json({ error: 'Request not found' }, { status: 404 })
    return NextResponse.json(detail)
  } catch (err) {
    console.error('[admin.marketplace-requests.detail] error', { id, err })
    return NextResponse.json({ error: 'Could not load request' }, { status: 500 })
  }
}
