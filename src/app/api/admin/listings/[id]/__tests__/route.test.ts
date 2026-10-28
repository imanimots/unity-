import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://fake-project.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'fake-service-role-key'

const requireAdminForRoute = vi.fn()
const getAdminServiceClient = vi.fn()
vi.mock('@/lib/admin/route-helpers', () => ({
  requireAdminForRoute: (...args: unknown[]) => requireAdminForRoute(...args),
  getAdminServiceClient: (...args: unknown[]) => getAdminServiceClient(...args),
  isValidUuid: (v: string) => /^[0-9a-f-]{36}$/i.test(v),
}))

vi.mock('@/lib/listings/completeness', () => ({ computeListingCompleteness: vi.fn().mockReturnValue({ score: 100, missing: [] }) }))
vi.mock('@/lib/listings/activation', () => ({ checkActivationEligibility: vi.fn().mockReturnValue({ eligible: true, reasons: [] }) }))
vi.mock('@/lib/listings/evidence-access', () => ({ listOwnershipEvidence: vi.fn().mockResolvedValue([]) }))

const { GET } = await import('../route')

const LISTING_ID = '11111111-1111-1111-1111-111111111111'

/** Terminal, empty-by-default per-table mock for the detail route's wide Promise.all fan-out, with the listings row/profile embed under direct test control. */
function fakeListingDetailAdmin(listingRow: Record<string, unknown> | null) {
  const listingQuery: Record<string, unknown> = {}
  for (const method of ['select', 'eq']) listingQuery[method] = () => listingQuery
  listingQuery.maybeSingle = () => Promise.resolve({ data: listingRow, error: null })

  const empty: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'order', 'neq']) empty[method] = () => empty
  empty.then = (resolve: (v: { data: unknown[]; error: null }) => void) => resolve({ data: [], error: null })
  empty.maybeSingle = () => Promise.resolve({ data: null, error: null })

  return {
    from: (table: string) => (table === 'listings' ? listingQuery : empty),
  }
}

function call(id = LISTING_ID) {
  return GET(new NextRequest(`http://localhost/api/admin/listings/${id}`), { params: Promise.resolve({ id }) })
}

beforeEach(() => {
  requireAdminForRoute.mockReset().mockResolvedValue({ ok: true, requester: { userId: 'admin', profile: {} } })
  getAdminServiceClient.mockReset()
})

describe('GET /api/admin/listings/[id] — real-data scope (category: ADMIN-CONTROL-CENTRE-BATCH-D3-D)', () => {
  const baseListing = {
    id: LISTING_ID, title: 'Camera', category: 'electronics', risk_tier: 'low', status: 'active',
    daily_rate: 100, replacement_value: 1000, merchant_id: 'm1', created_at: '2026-01-01T00:00:00Z',
    is_test: false, category_metadata: {}, condition: 'good', description: 'x', min_rental_days: 1,
    max_rental_days: 30, shipping_payer: 'merchant', condition_confirmed: true, known_defects: null,
    quantity_available: 1, province: 'GP', city: 'JHB', available_from: null, deposit_required: false,
    insurance_amount: null, wear_description: null, subcategory_id: null, weekly_rate: null,
    profiles: { full_name: 'Merchant', kyc_status: 'approved', unity_score: 4, created_at: '2026-01-01', data_classification: 'real' },
  }

  it('1. a confirmed-real, non-test listing resolves normally', async () => {
    getAdminServiceClient.mockResolvedValue(fakeListingDetailAdmin(baseListing))
    const res = await call()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.listing.id).toBe(LISTING_ID)
  })

  it('2. is_test=true listing is treated as not found even though the owning merchant is real', async () => {
    getAdminServiceClient.mockResolvedValue(fakeListingDetailAdmin({ ...baseListing, is_test: true }))
    const res = await call()
    expect(res.status).toBe(404)
  })

  it('3. a test-classified merchant owner is treated as not found even though is_test=false', async () => {
    getAdminServiceClient.mockResolvedValue(
      fakeListingDetailAdmin({ ...baseListing, profiles: { ...baseListing.profiles, data_classification: 'test' } })
    )
    const res = await call()
    expect(res.status).toBe(404)
  })

  it('4. an unknown-classified merchant owner is treated as not found', async () => {
    getAdminServiceClient.mockResolvedValue(
      fakeListingDetailAdmin({ ...baseListing, profiles: { ...baseListing.profiles, data_classification: 'unknown' } })
    )
    const res = await call()
    expect(res.status).toBe(404)
  })

  it('5. a genuinely missing listing row returns 404', async () => {
    getAdminServiceClient.mockResolvedValue(fakeListingDetailAdmin(null))
    const res = await call()
    expect(res.status).toBe(404)
  })

  it('6. admin authorization is required before any query runs', async () => {
    requireAdminForRoute.mockResolvedValue({ ok: false, response: new Response(JSON.stringify({ error: 'nope' }), { status: 401 }) })
    const res = await call()
    expect(res.status).toBe(401)
    expect(getAdminServiceClient).not.toHaveBeenCalled()
  })
})
