import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://fake-project.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'fake-service-role-key'

const requireAdminForRoute = vi.fn()
const getAdminServiceClient = vi.fn()
vi.mock('@/lib/admin/route-helpers', () => ({
  requireAdminForRoute: (...args: unknown[]) => requireAdminForRoute(...args),
  getAdminServiceClient: (...args: unknown[]) => getAdminServiceClient(...args),
}))

vi.mock('@/lib/admin/users-service', () => ({
  getRealUserOverviewCounts: vi.fn().mockResolvedValue({ totalUsers: 1, activeUsers: 1, merchants: 1, renters: 1, suspendedUsers: 0, restrictedUsers: 0 }),
}))
vi.mock('@/lib/admin/listings-service', () => ({
  getRealListingOverviewCounts: vi.fn().mockResolvedValue({ activeListings: 2, suspendedListings: 0 }),
}))
vi.mock('@/lib/admin/operations-service', () => ({
  getRealBookingOverviewCounts: vi.fn().mockResolvedValue({
    requestedBookings: 3, acceptedAwaitingPaymentBookings: 0, financiallyReadyBookings: 0, activeRentals: 0, overduePaymentDeadlines: 0,
  }),
}))
vi.mock('@/lib/admin/barter-service', () => ({
  getRealBarterOverviewCounts: vi.fn().mockResolvedValue({
    proposedBarterAgreements: 4, acceptedBarterAgreements: 0, inProgressBarterAgreements: 0, disputedBarterAgreements: 0, adminHeldBarterAgreements: 0,
  }),
}))
vi.mock('@/lib/admin/orders-service', () => ({
  getRealOrderOverviewCounts: vi.fn().mockResolvedValue({
    ordersAwaitingPayment: 5, ordersPaidAwaitingShipment: 0, ordersShippedAwaitingDelivery: 0, ordersDisputed: 0, ordersPaymentFailed: 0,
  }),
}))
vi.mock('@/lib/admin/rent-to-buy-service', () => ({
  getRealRentToBuyOverviewCounts: vi.fn().mockResolvedValue({
    rtbAgreementsAwaitingFirstPayment: 6, rtbAgreementsActive: 0, rtbAgreementsDefaulted: 0, rtbAgreementsReturnRequired: 0, rtbAgreementsCompleted: 0,
  }),
}))

const { GET } = await import('../route')

/** Mixed-population RPC stand-in: every D3-D-owned field is intentionally a LARGE, obviously-mixed number so a passthrough (unfixed override) would be caught immediately by the assertions below. */
const MIXED_RPC_DATA = {
  total_users: 9999, active_users: 9999, merchants: 9999, renters: 9999, suspended_users: 9999, restricted_users: 9999,
  pending_kyc_reviews: 12, pending_ownership_reviews: 3, pending_listing_moderation: 7,
  active_listings: 9999, suspended_listings: 9999,
  requested_bookings: 9999, accepted_awaiting_payment_bookings: 9999, financially_ready_bookings: 9999, active_rentals: 9999, overdue_payment_deadlines: 9999,
  proposed_barter_agreements: 9999, accepted_barter_agreements: 9999, in_progress_barter_agreements: 9999, disputed_barter_agreements: 9999, admin_held_barter_agreements: 9999,
  orders_awaiting_payment: 9999, orders_paid_awaiting_shipment: 9999, orders_shipped_awaiting_delivery: 9999, orders_disputed: 9999, orders_payment_failed: 9999,
  rtb_agreements_awaiting_first_payment: 9999, rtb_agreements_active: 9999, rtb_agreements_defaulted: 9999, rtb_agreements_return_required: 9999, rtb_agreements_completed: 9999,
  failed_financial_workflows: 1, generated_at: '2026-01-01T00:00:00Z',
}

beforeEach(() => {
  requireAdminForRoute.mockReset().mockResolvedValue({ ok: true, requester: { userId: 'admin', profile: {} } })
  getAdminServiceClient.mockReset().mockResolvedValue({ rpc: vi.fn().mockResolvedValue({ data: MIXED_RPC_DATA, error: null }) })
})

describe('GET /api/admin/overview — D3-D-F1 real-data overrides (category: ADMIN-CONTROL-CENTRE-BATCH-D3-D-F1)', () => {
  it('1. listing/booking/barter/order/RTB fields are overridden with the scoped real counts, not the mixed RPC values', async () => {
    const res = await GET(new NextRequest('http://localhost/api/admin/overview'))
    const body = await res.json()
    expect(body.active_listings).toBe(2)
    expect(body.requested_bookings).toBe(3)
    expect(body.proposed_barter_agreements).toBe(4)
    expect(body.orders_awaiting_payment).toBe(5)
    expect(body.rtb_agreements_awaiting_first_payment).toBe(6)
  })

  it('2. operational work-queue fields (pending KYC/ownership/moderation) are NEVER overridden -- they pass through the RPC\'s own all-system value unchanged', async () => {
    const res = await GET(new NextRequest('http://localhost/api/admin/overview'))
    const body = await res.json()
    expect(body.pending_kyc_reviews).toBe(12)
    expect(body.pending_ownership_reviews).toBe(3)
    expect(body.pending_listing_moderation).toBe(7)
  })

  it('3. out-of-scope fields (e.g. failed_financial_workflows) are untouched', async () => {
    const res = await GET(new NextRequest('http://localhost/api/admin/overview'))
    const body = await res.json()
    expect(body.failed_financial_workflows).toBe(1)
  })

  it('4. admin authorization is required before any query runs', async () => {
    requireAdminForRoute.mockResolvedValue({ ok: false, response: new Response(JSON.stringify({ error: 'nope' }), { status: 401 }) })
    const res = await GET(new NextRequest('http://localhost/api/admin/overview'))
    expect(res.status).toBe(401)
    expect(getAdminServiceClient).not.toHaveBeenCalled()
  })
})
