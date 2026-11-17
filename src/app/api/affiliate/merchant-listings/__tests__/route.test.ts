import { describe, it, expect, vi, beforeEach } from 'vitest'

// E48 Risk 1 -- merchant-visible affiliate names. Verifies the route
// resolves affiliate_id -> display name via public_profiles (never the
// base profiles table, never email/phone/KYC fields) and that every
// query scoping the merchant's own data is actually invoked with the
// requesting merchant's id, not a wildcard -- the real protection
// against cross-merchant leakage lives in those .eq('merchant_id', ...)
// filters (and RLS, independently), so this test asserts they're called
// correctly rather than re-deriving RLS behavior in a fake client.
process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://fake-project.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'fake-service-role-key'

const getRequestProfile = vi.fn()
vi.mock('@/lib/supabase/require-admin', () => ({ getRequestProfile: (...args: unknown[]) => getRequestProfile(...args) }))

const MERCHANT_ID = '11111111-1111-4111-a111-111111111111'
const LISTING_ID = '22222222-2222-4222-a222-222222222222'
const AFFILIATE_ID = '33333333-3333-4333-a333-333333333333'

interface FakeTableConfig {
  data: unknown
  error?: unknown
}

function makeFakeAdmin(tables: Record<string, FakeTableConfig>) {
  const eqCalls: Record<string, [string, unknown][]> = {}

  function makeChain(table: string, resolved: FakeTableConfig) {
    const value = { data: resolved.data ?? null, error: resolved.error ?? null }
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (col: string, val: unknown) => {
        eqCalls[table] = eqCalls[table] ?? []
        eqCalls[table].push([col, val])
        return chain
      },
      in: () => chain,
      order: () => chain,
      then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => Promise.resolve(value).then(resolve, reject),
    }
    return chain
  }

  const from = vi.fn((table: string) => makeChain(table, tables[table] ?? { data: null, error: null }))
  return { from, eqCalls }
}

let nextAdmin: ReturnType<typeof makeFakeAdmin>
vi.mock('@supabase/supabase-js', () => ({ createClient: () => nextAdmin }))

const { GET } = await import('../route')

beforeEach(() => {
  getRequestProfile.mockReset()
})

describe('GET /api/affiliate/merchant-listings -- affiliate name exposure', () => {
  it('unauthenticated request is rejected', async () => {
    getRequestProfile.mockResolvedValue(null)
    nextAdmin = makeFakeAdmin({})

    const res = await GET()
    expect(res.status).toBe(401)
  })

  it('resolves the referring affiliate name via public_profiles for the merchant\'s own listing', async () => {
    getRequestProfile.mockResolvedValue({ userId: MERCHANT_ID })
    nextAdmin = makeFakeAdmin({
      listings: { data: [{ id: LISTING_ID, title: 'Camera', accepts_affiliates: true, affiliate_commission_rate: 10, affiliate_enabled_at: null, affiliate_disabled_at: null }] },
      affiliate_attributions: { data: [{ listing_id: LISTING_ID, affiliate_id: AFFILIATE_ID }] },
      affiliate_commissions: { data: [] },
      public_profiles: { data: [{ id: AFFILIATE_ID, display_name: 'Jane Doe', full_name: null }] },
    })

    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.listings).toHaveLength(1)
    expect(body.listings[0].referrerNames).toEqual(['Jane Doe'])

    // Scoped to the requesting merchant's own data at every table --
    // the actual cross-merchant protection.
    expect(nextAdmin.eqCalls.listings).toContainEqual(['merchant_id', MERCHANT_ID])
    expect(nextAdmin.eqCalls.affiliate_attributions).toContainEqual(['merchant_id', MERCHANT_ID])
    expect(nextAdmin.eqCalls.affiliate_commissions).toContainEqual(['merchant_id', MERCHANT_ID])
  })

  it('never selects email/phone/KYC fields when resolving affiliate identity', async () => {
    getRequestProfile.mockResolvedValue({ userId: MERCHANT_ID })
    nextAdmin = makeFakeAdmin({
      listings: { data: [{ id: LISTING_ID, title: 'Camera', accepts_affiliates: true, affiliate_commission_rate: 10, affiliate_enabled_at: null, affiliate_disabled_at: null }] },
      affiliate_attributions: { data: [{ listing_id: LISTING_ID, affiliate_id: AFFILIATE_ID }] },
      affiliate_commissions: { data: [] },
      public_profiles: { data: [{ id: AFFILIATE_ID, display_name: 'Jane Doe', full_name: null }] },
    })

    await GET()
    // The route only ever reads from public_profiles for identity, never
    // the base `profiles` table (which carries email/phone/KYC fields).
    const calledTables = nextAdmin.from.mock.calls.map((c: unknown[]) => c[0])
    expect(calledTables).toContain('public_profiles')
    expect(calledTables).not.toContain('profiles')
  })

  it('a listing with no attributions or commissions has an empty referrerNames list', async () => {
    getRequestProfile.mockResolvedValue({ userId: MERCHANT_ID })
    nextAdmin = makeFakeAdmin({
      listings: { data: [{ id: LISTING_ID, title: 'Camera', accepts_affiliates: false, affiliate_commission_rate: 10, affiliate_enabled_at: null, affiliate_disabled_at: null }] },
      affiliate_attributions: { data: [] },
      affiliate_commissions: { data: [] },
    })

    const res = await GET()
    const body = await res.json()
    expect(body.listings[0].referrerNames).toEqual([])
  })

  it('no listings for the merchant short-circuits before querying affiliate tables', async () => {
    getRequestProfile.mockResolvedValue({ userId: MERCHANT_ID })
    nextAdmin = makeFakeAdmin({ listings: { data: [] } })

    const res = await GET()
    const body = await res.json()
    expect(body.listings).toEqual([])
    const calledTables = nextAdmin.from.mock.calls.map((c: unknown[]) => c[0])
    expect(calledTables).not.toContain('affiliate_attributions')
    expect(calledTables).not.toContain('public_profiles')
  })
})
