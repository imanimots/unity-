import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient } from '@/lib/admin/route-helpers'
import { listAdminOrders, ORDER_CSV_COLUMNS } from '@/lib/admin/orders-service'
import { csvResponse } from '@/lib/admin/csv'

/** GET /api/admin/orders -- real data, read-only monitoring, no mutating actions on this route. */
export async function GET(request: NextRequest) {
  const gate = await requireAdminForRoute(request, 'admin:orders:list')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Order storage is not configured' }, { status: 503 })
  }

  const { searchParams } = new URL(request.url)
  const disputedParam = searchParams.get('disputed')
  const filters = {
    status: searchParams.get('status') ?? undefined,
    paymentStatus: searchParams.get('paymentStatus') ?? undefined,
    disputed: disputedParam === 'true' ? true : disputedParam === 'false' ? false : undefined,
    buyerId: searchParams.get('buyerId') ?? undefined,
    sellerId: searchParams.get('sellerId') ?? undefined,
    search: searchParams.get('search') ?? undefined,
  }

  try {
    const orders = await listAdminOrders(admin, filters)

    if (searchParams.get('format') === 'csv') {
      return csvResponse('orders.csv', ORDER_CSV_COLUMNS, orders)
    }

    return NextResponse.json({ orders })
  } catch (err) {
    console.error('[admin.orders.list] error', err)
    return NextResponse.json({ error: 'Could not load orders' }, { status: 500 })
  }
}
