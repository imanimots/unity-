import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient } from '@/lib/admin/route-helpers'
import { getRealUserOverviewCounts } from '@/lib/admin/users-service'
import { getRealListingOverviewCounts } from '@/lib/admin/listings-service'
import { getRealBookingOverviewCounts } from '@/lib/admin/operations-service'
import { getRealBarterOverviewCounts } from '@/lib/admin/barter-service'
import { getRealOrderOverviewCounts } from '@/lib/admin/orders-service'
import { getRealRentToBuyOverviewCounts } from '@/lib/admin/rent-to-buy-service'

/**
 * GET /api/admin/overview — one RPC round trip
 * (get_admin_overview_stats(), 20260808000002), all aggregation done
 * server-side in SQL. The browser never computes a sensitive total.
 *
 * D3-C/D3-D-F1: the account/listing/booking/barter/order/RTB fields
 * are overridden with confirmed-real-only counts, same override as
 * src/app/admin/page.tsx -- see each getReal*OverviewCounts helper's
 * own doc comment for why and for which fields remain the RPC's
 * unscoped values in this phase (review-queue depths and every
 * Finance/Advertising/Support field).
 */
export async function GET(request: NextRequest) {
  const gate = await requireAdminForRoute(request, 'admin:overview')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Overview storage is not configured' }, { status: 503 })
  }

  const [{ data, error }, realUserCounts, realListingCounts, realBookingCounts, realBarterCounts, realOrderCounts, realRtbCounts] = await Promise.all([
    admin.rpc('get_admin_overview_stats'),
    getRealUserOverviewCounts(admin),
    getRealListingOverviewCounts(admin),
    getRealBookingOverviewCounts(admin),
    getRealBarterOverviewCounts(admin),
    getRealOrderOverviewCounts(admin),
    getRealRentToBuyOverviewCounts(admin),
  ])
  if (error) {
    console.error('[admin.overview] RPC error', error)
    return NextResponse.json({ error: 'Could not load the overview' }, { status: 500 })
  }

  return NextResponse.json({
    ...data,
    total_users: realUserCounts.totalUsers,
    active_users: realUserCounts.activeUsers,
    merchants: realUserCounts.merchants,
    renters: realUserCounts.renters,
    suspended_users: realUserCounts.suspendedUsers,
    restricted_users: realUserCounts.restrictedUsers,
    active_listings: realListingCounts.activeListings,
    suspended_listings: realListingCounts.suspendedListings,
    requested_bookings: realBookingCounts.requestedBookings,
    accepted_awaiting_payment_bookings: realBookingCounts.acceptedAwaitingPaymentBookings,
    financially_ready_bookings: realBookingCounts.financiallyReadyBookings,
    active_rentals: realBookingCounts.activeRentals,
    overdue_payment_deadlines: realBookingCounts.overduePaymentDeadlines,
    proposed_barter_agreements: realBarterCounts.proposedBarterAgreements,
    accepted_barter_agreements: realBarterCounts.acceptedBarterAgreements,
    in_progress_barter_agreements: realBarterCounts.inProgressBarterAgreements,
    disputed_barter_agreements: realBarterCounts.disputedBarterAgreements,
    admin_held_barter_agreements: realBarterCounts.adminHeldBarterAgreements,
    orders_awaiting_payment: realOrderCounts.ordersAwaitingPayment,
    orders_paid_awaiting_shipment: realOrderCounts.ordersPaidAwaitingShipment,
    orders_shipped_awaiting_delivery: realOrderCounts.ordersShippedAwaitingDelivery,
    orders_disputed: realOrderCounts.ordersDisputed,
    orders_payment_failed: realOrderCounts.ordersPaymentFailed,
    rtb_agreements_awaiting_first_payment: realRtbCounts.rtbAgreementsAwaitingFirstPayment,
    rtb_agreements_active: realRtbCounts.rtbAgreementsActive,
    rtb_agreements_defaulted: realRtbCounts.rtbAgreementsDefaulted,
    rtb_agreements_return_required: realRtbCounts.rtbAgreementsReturnRequired,
    rtb_agreements_completed: realRtbCounts.rtbAgreementsCompleted,
  })
}
