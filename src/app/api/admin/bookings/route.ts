import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient } from '@/lib/admin/route-helpers'
import { listAdminBookings } from '@/lib/admin/operations-service'
import { csvResponse } from '@/lib/admin/csv'

/** GET /api/admin/bookings — real data, no mutating actions on this route. */
export async function GET(request: NextRequest) {
  const gate = await requireAdminForRoute(request, 'admin:bookings:list')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Booking storage is not configured' }, { status: 503 })
  }

  const { searchParams } = new URL(request.url)
  const filters = { status: searchParams.get('status') ?? undefined, search: searchParams.get('search') ?? undefined }

  try {
    const bookings = await listAdminBookings(admin, filters)

    if (searchParams.get('format') === 'csv') {
      return csvResponse(
        'bookings.csv',
        ['id', 'bookingReference', 'listingTitle', 'renterName', 'merchantName', 'status', 'financialReadiness', 'startAt', 'endAt', 'paymentDueAt', 'createdAt'],
        bookings
      )
    }

    return NextResponse.json({ bookings })
  } catch (err) {
    console.error('[admin.bookings.list] error', err)
    return NextResponse.json({ error: 'Could not load bookings' }, { status: 500 })
  }
}
