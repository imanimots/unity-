import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { getAdminOrderDetail } from '@/lib/admin/orders-service'

interface RouteParams {
  params: Promise<{ id: string }>
}

/** GET /api/admin/orders/[id] -- full order detail, admin-only, read-only. */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { id: orderId } = await params
  if (!isValidUuid(orderId)) {
    return NextResponse.json({ error: 'Invalid order id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:orders:detail')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Order storage is not configured' }, { status: 503 })
  }

  const detail = await getAdminOrderDetail(admin, orderId)
  if (!detail) {
    return NextResponse.json({ error: 'Order not found' }, { status: 404 })
  }

  return NextResponse.json(detail)
}
