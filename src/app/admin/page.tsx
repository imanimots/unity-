import { requireAdmin } from '@/lib/supabase/require-admin'
import { getAdminServiceClient } from '@/lib/admin/route-helpers'
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
  generated_at: string
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

  const { data, error } = await admin.rpc('get_admin_overview_stats')
  if (error || !data) {
    return <div className="p-8 text-sm text-red-600">Could not load the overview.</div>
  }
  const stats = data as OverviewStats

  return (
    <div className="p-6 lg:p-8 space-y-8">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <AdminPageHeader eyebrow="Operations" title="Overview" />
        <p className="text-xs text-[#9B8B85]">Last updated {formatDateTime(stats.generated_at)}</p>
      </div>

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
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">Operational health</p>
        <div className="grid grid-cols-2 gap-4">
          <StatCard label="Failed workflows" value={stats.failed_financial_workflows} />
          <StatCard label="Retryable email failures" value={stats.retryable_email_failures} />
        </div>
      </section>
    </div>
  )
}
