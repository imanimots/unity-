import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { fakeServiceRoleClient } from '@/app/api/__tests__/fake-service-role-client'

// D2-F1 (ADMIN-CONTROL-CENTRE-BATCH-D2-F1) -- proves listing_published
// fires exactly once on a genuine first activation, never on a
// network-level replay of that same activation request (same
// idempotency_key), never on a failed RPC call. Does not re-test the
// route's own pre-existing eligibility/completeness business logic
// (bypassed via mocks below, since it's unrelated to this phase's
// analytics-emission correctness) -- only the D2/D2-F1 analytics
// emission and its replay gating.
const ADMIN_ID = '99999999-9999-9999-9999-999999999999'
const LISTING_ID = '33333333-3333-4333-a333-333333333333'
const MERCHANT_ID = '44444444-4444-4444-a444-444444444444'

const requireAdminForRoute = vi.fn()
const getAdminServiceClient = vi.fn()
vi.mock('@/lib/admin/route-helpers', () => ({
  requireAdminForRoute: (...args: unknown[]) => requireAdminForRoute(...args),
  getAdminServiceClient: (...args: unknown[]) => getAdminServiceClient(...args),
  isValidUuid: (v: string) => /^[0-9a-f-]{36}$/i.test(v),
}))

vi.mock('@/lib/listings/activation', () => ({
  checkActivationEligibility: () => ({ eligible: true, reasons: [] }),
}))
vi.mock('@/lib/listings/completeness', () => ({
  computeListingCompleteness: () => ({ isComplete: true, missing: [] }),
}))
vi.mock('@/lib/risk/engine', () => ({
  getRiskRequirements: () => ({ ownershipVerificationRequired: false }),
}))
vi.mock('@/lib/email', () => ({ sendTemplate: () => Promise.resolve(), loadListingEmailContext: () => Promise.resolve(null) }))

const checkIdempotentReplay = vi.fn()
vi.mock('@/lib/bookings/idempotency', () => ({
  checkIdempotentReplay: (...args: unknown[]) => checkIdempotentReplay(...args),
}))

const recordAnalyticsEvent = vi.fn()
vi.mock('@/lib/analytics/server', () => ({
  recordAnalyticsEvent: (...args: unknown[]) => recordAnalyticsEvent(...args),
}))

let nextAdmin: ReturnType<typeof fakeServiceRoleClient>

const { POST } = await import('../route')

function req() {
  return new NextRequest(`http://localhost/api/admin/listings/${LISTING_ID}/activate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
}
function call() {
  return POST(req(), { params: Promise.resolve({ id: LISTING_ID }) })
}

function baseTableResponses(isTest = false) {
  return {
    listings: { data: { id: LISTING_ID, merchant_id: MERCHANT_ID, is_test: isTest, category: 'tools', status: 'pending' } },
    profiles: { data: { kyc_status: 'approved', unity_score: 5, account_status: 'active' } },
    listing_private_details: { data: { private_category_metadata: {} } },
    listing_requirements: { data: {} },
    listing_media: { data: [] },
    listing_moderation: { data: { moderation_status: 'approved' } },
    listing_ownership_verification: { data: null },
    listing_declarations: { data: [] },
  }
}

beforeEach(() => {
  recordAnalyticsEvent.mockReset()
  recordAnalyticsEvent.mockResolvedValue(undefined)
  checkIdempotentReplay.mockReset()
  checkIdempotentReplay.mockResolvedValue({ status: 'none' })
  requireAdminForRoute.mockReset()
  requireAdminForRoute.mockResolvedValue({ ok: true, requester: { userId: ADMIN_ID, profile: {} } })
  getAdminServiceClient.mockReset()
})

describe('POST /api/admin/listings/[id]/activate -- listing_published analytics instrumentation (category: ADMIN-CONTROL-CENTRE-BATCH-D2-F1)', () => {
  it('1. fires listing_published exactly once on a genuine first activation', async () => {
    nextAdmin = fakeServiceRoleClient(baseTableResponses(false), { activate_listing: { data: { listing_id: LISTING_ID, status: 'active' } } })
    getAdminServiceClient.mockResolvedValue(nextAdmin)
    const res = await call()
    expect(res.status).toBe(200)
    expect(recordAnalyticsEvent).toHaveBeenCalledTimes(1)
    expect(recordAnalyticsEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventName: 'listing_published', entityType: 'listing', entityId: LISTING_ID, dataClassification: 'real' })
    )
  })

  it('2. derives dataClassification "test" for a QA-flagged listing', async () => {
    nextAdmin = fakeServiceRoleClient(baseTableResponses(true), { activate_listing: { data: { listing_id: LISTING_ID, status: 'active' } } })
    getAdminServiceClient.mockResolvedValue(nextAdmin)
    await call()
    expect(recordAnalyticsEvent).toHaveBeenCalledWith(expect.objectContaining({ dataClassification: 'test' }))
  })

  it('3. never fires when the activation RPC returns an error', async () => {
    nextAdmin = fakeServiceRoleClient(baseTableResponses(false), { activate_listing: { data: null, error: { message: 'listing status "active" is not eligible for activation' } } })
    getAdminServiceClient.mockResolvedValue(nextAdmin)
    const res = await call()
    expect(res.status).not.toBe(200)
    expect(recordAnalyticsEvent).not.toHaveBeenCalled()
  })

  it('4. never fires on a network-level replay of the activation request -- a prior idempotency_keys row means the RPC\'s success is a cached replay, not a fresh transition', async () => {
    nextAdmin = fakeServiceRoleClient(baseTableResponses(false), { activate_listing: { data: { listing_id: LISTING_ID, status: 'active' } } })
    getAdminServiceClient.mockResolvedValue(nextAdmin)
    checkIdempotentReplay.mockResolvedValue({ status: 'replay', result: { listing_id: LISTING_ID, status: 'active' } })
    const res = await POST(
      new NextRequest(`http://localhost/api/admin/listings/${LISTING_ID}/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idempotency_key: 'a-stable-admin-key-123' }),
      }),
      { params: Promise.resolve({ id: LISTING_ID }) }
    )
    expect(res.status).toBe(200)
    expect(recordAnalyticsEvent).not.toHaveBeenCalled()
  })

  it('5. a rejecting recordAnalyticsEvent still returns the core operation\'s own success response -- analytics failure never turns a successful activation into a 500', async () => {
    nextAdmin = fakeServiceRoleClient(baseTableResponses(false), { activate_listing: { data: { listing_id: LISTING_ID, status: 'active' } } })
    getAdminServiceClient.mockResolvedValue(nextAdmin)
    recordAnalyticsEvent.mockRejectedValue(new Error('analytics storage unavailable'))
    const res = await call()
    expect(res.status).toBe(200)
  })
})
