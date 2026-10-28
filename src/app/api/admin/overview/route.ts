import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient } from '@/lib/admin/route-helpers'
import { getRealUserOverviewCounts } from '@/lib/admin/users-service'
import { getRealListingOverviewCounts } from '@/lib/admin/listings-service'
import { getRealBookingOverviewCounts } from '@/lib/admin/operations-service'
import { getRealBarterOverviewCounts } from '@/lib/admin/barter-service'
import { getRealOrderOverviewCounts } from '@/lib/admin/orders-service'
import { getRealRentToBuyOverviewCounts } from '@/lib/admin/rent-to-buy-service'
import { getRealPayoutOverviewCounts } from '@/lib/admin/payouts-service'
import { getRealSubscriptionOverviewCounts } from '@/lib/admin/subscriptions-service'
import { getRealUnityCommissionOverviewCounts } from '@/lib/admin/commissions-service'
import { getRealAffiliateOverviewCounts } from '@/lib/admin/affiliate-service'
import { getRealEscrowOverviewCounts } from '@/lib/admin/escrow-service'

/**
 * GET /api/admin/overview — one RPC round trip
 * (get_admin_overview_stats(), 20260808000002), all aggregation done
 * server-side in SQL. The browser never computes a sensitive total.
 *
 * D3-C/D3-D-F1/D3-E: the account/listing/booking/barter/order/RTB/
 * payout/subscription/unity-commission/affiliate/escrow fields are
 * overridden with confirmed-real-only counts, same override as
 * src/app/admin/page.tsx -- see each getReal*OverviewCounts helper's
 * own doc comment for why and for which fields remain the RPC's
 * unscoped, deliberately all-system values (review-queue depths,
 * failed workflows, email retries) or are out of scope (Support, KYC).
 * Advertising has no Overview presence at all.
 */
export async function GET(request: NextRequest) {
  const gate = await requireAdminForRoute(request, 'admin:overview')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Overview storage is not configured' }, { status: 503 })
  }

  const [
    { data, error },
    realUserCounts,
    realListingCounts,
    realBookingCounts,
    realBarterCounts,
    realOrderCounts,
    realRtbCounts,
    realPayoutCounts,
    realSubscriptionCounts,
    realUnityCommissionCounts,
    realAffiliateCounts,
    realEscrowCounts,
  ] = await Promise.all([
    admin.rpc('get_admin_overview_stats'),
    getRealUserOverviewCounts(admin),
    getRealListingOverviewCounts(admin),
    getRealBookingOverviewCounts(admin),
    getRealBarterOverviewCounts(admin),
    getRealOrderOverviewCounts(admin),
    getRealRentToBuyOverviewCounts(admin),
    getRealPayoutOverviewCounts(admin),
    getRealSubscriptionOverviewCounts(admin),
    getRealUnityCommissionOverviewCounts(admin),
    getRealAffiliateOverviewCounts(admin),
    getRealEscrowOverviewCounts(admin),
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
    merchant_payouts_pending: realPayoutCounts.merchantPayoutsPending,
    merchant_payouts_processing: realPayoutCounts.merchantPayoutsProcessing,
    merchant_payouts_failed: realPayoutCounts.merchantPayoutsFailed,
    merchant_payouts_pending_overdue: realPayoutCounts.merchantPayoutsPendingOverdue,
    merchant_payouts_processing_overdue: realPayoutCounts.merchantPayoutsProcessingOverdue,
    merchant_subscriptions_pro: realSubscriptionCounts.merchantSubscriptionsPro,
    merchant_subscriptions_elite: realSubscriptionCounts.merchantSubscriptionsElite,
    merchant_subscriptions_pending_change: realSubscriptionCounts.merchantSubscriptionsPendingChange,
    merchant_subscriptions_cancelled: realSubscriptionCounts.merchantSubscriptionsCancelled,
    merchant_subscriptions_due_for_reversion: realSubscriptionCounts.merchantSubscriptionsDueForReversion,
    unity_commissions_pending: realUnityCommissionCounts.unityCommissionsPending,
    unity_commissions_held: realUnityCommissionCounts.unityCommissionsHeld,
    unity_commissions_earned: realUnityCommissionCounts.unityCommissionsEarned,
    unity_commissions_voided: realUnityCommissionCounts.unityCommissionsVoided,
    unity_commissions_high_value_sales: realUnityCommissionCounts.unityCommissionsHighValueSales,
    active_affiliates: realAffiliateCounts.activeAffiliates,
    affiliate_commissions_pending: realAffiliateCounts.affiliateCommissionsPending,
    affiliate_commissions_held: realAffiliateCounts.affiliateCommissionsHeld,
    affiliate_commissions_payout_queued: realAffiliateCounts.affiliateCommissionsPayoutQueued,
    affiliate_commissions_failed: realAffiliateCounts.affiliateCommissionsFailed,
    escrow_transactions_pending: realEscrowCounts.escrowTransactionsPending,
    escrow_transactions_funded: realEscrowCounts.escrowTransactionsFunded,
    escrow_transactions_released: realEscrowCounts.escrowTransactionsReleased,
    escrow_transactions_refunded: realEscrowCounts.escrowTransactionsRefunded,
    escrow_transactions_failed: realEscrowCounts.escrowTransactionsFailed,
  })
}
