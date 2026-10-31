import Link from 'next/link'
import type { SupabaseClient } from '@supabase/supabase-js'
import { requireAdmin } from '@/lib/supabase/require-admin'
import { getAdminServiceClient } from '@/lib/admin/route-helpers'
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
import { getIntelligenceInsights, type IntelligenceResult } from '@/lib/admin/intelligence-service'
import { StatCard, AdminPageHeader, formatDateTime } from '@/components/admin/ui'

interface OverviewStats {
  total_users: number
  active_users: number
  merchants: number
  renters: number
  suspended_users: number
  restricted_users: number
  pending_kyc_reviews: number
  pending_ownership_reviews: number
  pending_listing_moderation: number
  active_listings: number
  suspended_listings: number
  requested_bookings: number
  accepted_awaiting_payment_bookings: number
  financially_ready_bookings: number
  active_rentals: number
  overdue_payment_deadlines: number
  failed_financial_workflows: number
  retryable_email_failures: number
  proposed_barter_agreements: number
  accepted_barter_agreements: number
  in_progress_barter_agreements: number
  disputed_barter_agreements: number
  admin_held_barter_agreements: number
  orders_awaiting_payment: number
  orders_paid_awaiting_shipment: number
  orders_shipped_awaiting_delivery: number
  orders_disputed: number
  orders_payment_failed: number
  rtb_agreements_awaiting_first_payment: number
  rtb_agreements_active: number
  rtb_agreements_defaulted: number
  rtb_agreements_return_required: number
  rtb_agreements_completed: number
  affiliate_commissions_pending: number
  affiliate_commissions_held: number
  affiliate_commissions_payout_queued: number
  affiliate_commissions_failed: number
  active_affiliates: number
  merchant_payouts_pending: number
  merchant_payouts_processing: number
  merchant_payouts_failed: number
  merchant_payouts_pending_overdue: number
  merchant_payouts_processing_overdue: number
  merchant_subscriptions_pro: number
  merchant_subscriptions_elite: number
  merchant_subscriptions_pending_change: number
  merchant_subscriptions_cancelled: number
  merchant_subscriptions_due_for_reversion: number
  unity_commissions_pending: number
  unity_commissions_held: number
  unity_commissions_earned: number
  unity_commissions_voided: number
  unity_commissions_high_value_sales: number
  escrow_transactions_pending: number
  escrow_transactions_funded: number
  escrow_transactions_released: number
  escrow_transactions_refunded: number
  escrow_transactions_failed: number
  generated_at: string
}

/**
 * E1-F1 defense-in-depth: getIntelligenceInsights() already isolates
 * every one of its own ~10 input sources internally (see
 * SourceOutcome/loadSource in intelligence-service.ts) and should never
 * reject. This is a second, Intelligence-only safety net so that even
 * an unforeseen failure inside it can never take down the rest of this
 * already-real Admin Overview page -- it never wraps or touches any of
 * the other Promise.all entries below.
 */
async function loadIntelligenceSafely(admin: SupabaseClient): Promise<IntelligenceResult> {
  try {
    return await getIntelligenceInsights(admin)
  } catch {
    return {
      generatedAt: new Date().toISOString(),
      period: '30d',
      summary: { totalInsights: 0, highPriority: 0, opportunities: 0, risksAndWatch: 0, dataQualityLimitations: 0, realData: { highPriority: 0, opportunities: 0 }, operational: { highPriority: 0 } },
      insights: [],
      sourceHealth: [],
    }
  }
}

/**
 * Real admin overview — replaces the Step 1 hardcoded ADMIN_MOCK_STATS
 * page. Server component: calls the aggregate RPC directly (no internal
 * fetch round trip through /api/admin/overview, which exists for the
 * client-side pages that need to re-poll).
 */
export default async function AdminOverviewPage() {
  const requester = await requireAdmin()
  if (!requester) {
    return <div className="p-8 text-sm text-[#9B8B85]">You must be signed in as an administrator.</div>
  }

  const admin = await getAdminServiceClient()
  if (!admin) {
    return <div className="p-8 text-sm text-[#9B8B85]">Overview storage is not configured.</div>
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
    intelligence,
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
    loadIntelligenceSafely(admin),
  ])
  if (error || !data) {
    return <div className="p-8 text-sm text-red-600">Could not load the overview.</div>
  }
  // D3-C/D3-D-F1/D3-E: the account/listing/booking/barter/order/RTB/
  // payout/subscription/unity-commission/affiliate/escrow metrics below
  // are overridden with confirmed-real-only counts --
  // get_admin_overview_stats() itself counts every row with no
  // classification awareness and this phase does not migrate it in
  // place. pending_kyc_reviews/pending_ownership_reviews/
  // pending_listing_moderation, failed_financial_workflows, and
  // retryable_email_failures remain the RPC's own unscoped,
  // deliberately all-system value -- they are operational work queues
  // (an admin must see and act on every pending/failed item regardless
  // of classification), not business-volume metrics. Advertising has
  // no Overview presence at all (confirmed: get_admin_overview_stats()
  // has zero advertising fields). Every remaining field (Support, KYC)
  // is out of scope for this phase.
  const stats: OverviewStats = {
    ...(data as OverviewStats),
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
  }

  const degradedSourceCount = intelligence.sourceHealth.filter((s) => s.status === 'degraded').length

  return (
    <div className="p-6 lg:p-8 space-y-8">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <AdminPageHeader eyebrow="Operations" title="Overview" />
        <p className="text-xs text-[#9B8B85]">Last updated {formatDateTime(stats.generated_at)}</p>
      </div>

      {/* Homepage summary card -- reuses getIntelligenceInsights(), the exact same function /admin/intelligence itself calls (src/lib/admin/intelligence-service.ts), never a parallel implementation, and reads only the service's own pre-computed summary fields (never re-filtering/recomputing insight categorization here). E1-F1: Real Data and Operational (all-system) counts are shown as two visibly separate groups rather than one scope-blind total, so this card can never read as a single confirmed-real business KPI when part of it is actually an all-system workload count. */}
      <Link href="/admin/intelligence" className="block bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5 hover:border-[#8B1A1A] transition-colors">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-1">AI R&amp;D</p>
            <h2 className="text-base font-bold text-[#1A0A0A] dark:text-[#F5F0ED]">AI R&amp;D &amp; Intelligence</h2>
          </div>
          <span className="text-xs font-medium uppercase tracking-[0.08em] text-[#8B1A1A] whitespace-nowrap">View Intelligence →</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
          <div className="border border-[#8B1A1A]/20 rounded-lg p-3">
            <p className="text-[10px] font-medium uppercase tracking-[0.1em] text-[#8B1A1A] mb-2">Real Data</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-[11px] uppercase tracking-[0.1em] text-[#9B8B85]">High priority</p>
                <p className="text-xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] tabular-nums">{intelligence.summary.realData.highPriority}</p>
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-[0.1em] text-[#9B8B85]">Opportunities</p>
                <p className="text-xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] tabular-nums">{intelligence.summary.realData.opportunities}</p>
              </div>
            </div>
          </div>
          <div className="border border-[#6B5B55]/20 rounded-lg p-3">
            <p className="text-[10px] font-medium uppercase tracking-[0.1em] text-[#6B5B55] dark:text-[#9B8B85] mb-2">Operational (all-system)</p>
            <div>
              <p className="text-[11px] uppercase tracking-[0.1em] text-[#9B8B85]">High priority</p>
              <p className="text-xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] tabular-nums">{intelligence.summary.operational.highPriority}</p>
            </div>
          </div>
        </div>
        <div className="mt-3">
          <p className="text-[11px] uppercase tracking-[0.1em] text-[#9B8B85]">Data limitations</p>
          <p className="text-xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] tabular-nums">{intelligence.summary.dataQualityLimitations}</p>
        </div>
        {/* E2: a concise, non-alarming degraded-source indicator -- only rendered when something is actually degraded; full Source Health detail lives on /admin/intelligence, not duplicated here. */}
        {degradedSourceCount > 0 && (
          <p className="mt-3 text-xs text-amber-700 dark:text-amber-400">Data sources degraded: {degradedSourceCount}</p>
        )}
      </Link>

      <section className="space-y-3">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">Users</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-4">
          <StatCard label="Total users" value={stats.total_users} />
          <StatCard label="Active users" value={stats.active_users} />
          <StatCard label="Merchants" value={stats.merchants} />
          <StatCard label="Renters" value={stats.renters} />
          <StatCard label="Restricted" value={stats.restricted_users} />
          <StatCard label="Suspended" value={stats.suspended_users} />
        </div>
      </section>

      <section className="space-y-3">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">Review queues</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          <StatCard label="Pending KYC" value={stats.pending_kyc_reviews} />
          <StatCard label="Pending ownership" value={stats.pending_ownership_reviews} />
          <StatCard label="Pending moderation" value={stats.pending_listing_moderation} />
        </div>
      </section>

      <section className="space-y-3">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">Listings</p>
        <div className="grid grid-cols-2 gap-4">
          <StatCard label="Active listings" value={stats.active_listings} />
          <StatCard label="Suspended listings" value={stats.suspended_listings} />
        </div>
      </section>

      <section className="space-y-3">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">Bookings</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
          <StatCard label="Requested" value={stats.requested_bookings} />
          <StatCard label="Awaiting payment" value={stats.accepted_awaiting_payment_bookings} />
          <StatCard label="Financially ready" value={stats.financially_ready_bookings} />
          <StatCard label="Active rentals" value={stats.active_rentals} />
          <StatCard label="Overdue deadlines" value={stats.overdue_payment_deadlines} />
        </div>
      </section>

      <section className="space-y-3">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">Barter</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
          <StatCard label="Proposed" value={stats.proposed_barter_agreements} />
          <StatCard label="Accepted" value={stats.accepted_barter_agreements} />
          <StatCard label="In progress" value={stats.in_progress_barter_agreements} />
          <StatCard label="Disputed" value={stats.disputed_barter_agreements} />
          <StatCard label="Admin held" value={stats.admin_held_barter_agreements} />
        </div>
      </section>

      <section className="space-y-3">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">Orders</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
          <StatCard label="Awaiting payment" value={stats.orders_awaiting_payment} />
          <StatCard label="Paid, awaiting shipment" value={stats.orders_paid_awaiting_shipment} />
          <StatCard label="Shipped, awaiting delivery" value={stats.orders_shipped_awaiting_delivery} />
          <StatCard label="Disputed" value={stats.orders_disputed} />
          <StatCard label="Payment failed" value={stats.orders_payment_failed} />
        </div>
      </section>

      <section className="space-y-3">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">Rent-to-Buy</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
          <StatCard label="Awaiting first payment" value={stats.rtb_agreements_awaiting_first_payment} />
          <StatCard label="Active" value={stats.rtb_agreements_active} />
          <StatCard label="Defaulted" value={stats.rtb_agreements_defaulted} />
          <StatCard label="Return required" value={stats.rtb_agreements_return_required} />
          <StatCard label="Completed" value={stats.rtb_agreements_completed} />
        </div>
      </section>

      <section className="space-y-3">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">Affiliates</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
          <StatCard label="Active affiliates" value={stats.active_affiliates} />
          <StatCard label="Commissions pending" value={stats.affiliate_commissions_pending} />
          <StatCard label="Commissions held" value={stats.affiliate_commissions_held} />
          <StatCard label="Payout queued" value={stats.affiliate_commissions_payout_queued} />
          <StatCard label="Payout failed" value={stats.affiliate_commissions_failed} />
        </div>
      </section>

      <section className="space-y-3">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">Merchant Payouts</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
          <StatCard label="Pending" value={stats.merchant_payouts_pending} />
          <StatCard label="Processing" value={stats.merchant_payouts_processing} />
          <StatCard label="Failed" value={stats.merchant_payouts_failed} />
          <StatCard label="Pending overdue" value={stats.merchant_payouts_pending_overdue} />
          <StatCard label="Processing overdue" value={stats.merchant_payouts_processing_overdue} />
        </div>
      </section>

      <section className="space-y-3">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">Merchant Subscriptions</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
          <StatCard label="Pro" value={stats.merchant_subscriptions_pro} />
          <StatCard label="Elite" value={stats.merchant_subscriptions_elite} />
          <StatCard label="Pending change" value={stats.merchant_subscriptions_pending_change} />
          <StatCard label="Cancelled (reverting)" value={stats.merchant_subscriptions_cancelled} />
          <StatCard label="Due for reversion" value={stats.merchant_subscriptions_due_for_reversion} />
        </div>
      </section>

      <section className="space-y-3">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">Unity Commissions</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
          <StatCard label="Pending" value={stats.unity_commissions_pending} />
          <StatCard label="Held" value={stats.unity_commissions_held} />
          <StatCard label="Earned" value={stats.unity_commissions_earned} />
          <StatCard label="Voided" value={stats.unity_commissions_voided} />
          <StatCard label="High-value sales" value={stats.unity_commissions_high_value_sales} />
        </div>
      </section>

      <section className="space-y-3">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">Secure Transactions (Escrow)</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
          <StatCard label="Pending" value={stats.escrow_transactions_pending} />
          <StatCard label="Held" value={stats.escrow_transactions_funded} />
          <StatCard label="Released" value={stats.escrow_transactions_released} />
          <StatCard label="Refunded" value={stats.escrow_transactions_refunded} />
          <StatCard label="Failed" value={stats.escrow_transactions_failed} />
        </div>
      </section>

      <section className="space-y-3">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">Operational health</p>
        <div className="grid grid-cols-2 gap-4">
          <StatCard label="Failed workflows" value={stats.failed_financial_workflows} />
          <StatCard label="Retryable email failures" value={stats.retryable_email_failures} />
        </div>
      </section>
    </div>
  )
}
