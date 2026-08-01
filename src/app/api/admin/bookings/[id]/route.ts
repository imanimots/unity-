import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { getAdminBookingDetail } from '@/lib/admin/operations-service'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * GET /api/admin/bookings/[id] — read-only. There is deliberately no
 * mutating counterpart on this route: admins may inspect a booking's
 * history, financial summary, and email events, but may not mark a
 * payment successful, rewrite a price, alter a deposit, manually
 * complete a rental, issue a refund, or reactivate an expired booking —
 * none of those have a safe existing RPC, and the brief explicitly
 * excludes building one this step.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { id: bookingId } = await params
  if (!isValidUuid(bookingId)) {
    return NextResponse.json({ error: 'Invalid booking id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:bookings:detail')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Booking storage is not configured' }, { status: 503 })
  }

  try {
    const detail = await getAdminBookingDetail(admin, bookingId)
    if (!detail) {
      return NextResponse.json({ error: 'Booking not found' }, { status: 404 })
    }
    return NextResponse.json(detail)
  } catch (err) {
    console.error('[admin.bookings.detail] error', { bookingId, err })
    return NextResponse.json({ error: 'Could not load this booking' }, { status: 500 })
  }
}
