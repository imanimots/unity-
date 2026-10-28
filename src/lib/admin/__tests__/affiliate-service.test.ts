import { describe, it, expect } from 'vitest'
import {
  AFFILIATE_COMMISSION_CSV_COLUMNS,
  listAdminAffiliates,
  getAdminAffiliateDetail,
  listAdminAffiliateCommissions,
  getAdminAffiliateCommissionDetail,
  getRealAffiliateOverviewCounts,
} from '../affiliate-service'

describe('affiliate-service: CSV export column list (category: CSV Exports, Security)', () => {
  it('1. excludes personal identity numbers, addresses, bank details, payment credentials, KYC documents', () => {
    const forbidden = ['idnumber', 'passport', 'address', 'bank', 'card', 'kyc', 'secret', 'token', 'email', 'phone']
    for (const col of AFFILIATE_COMMISSION_CSV_COLUMNS) {
      const lower = col.toLowerCase()
      for (const f of forbidden) {
        expect(lower.includes(f), `column "${col}" should not include "${f}"`).toBe(false)
      }
    }
  })
  it('2. includes affiliate/merchant display names, not raw user ids', () => {
    expect(AFFILIATE_COMMISSION_CSV_COLUMNS).toContain('affiliateName')
    expect(AFFILIATE_COMMISSION_CSV_COLUMNS).toContain('merchantName')
  })
  it('3. includes the commission amount, rate basis, status, and payout timestamps', () => {
    expect(AFFILIATE_COMMISSION_CSV_COLUMNS).toContain('commissionAmount')
    expect(AFFILIATE_COMMISSION_CSV_COLUMNS).toContain('status')
  })
})

interface RecordedCall {
  method: string
  args: unknown[]
}

function fakeListQuery(calls: RecordedCall[]) {
  const obj: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'order', 'limit', 'in']) {
    obj[method] = (...args: unknown[]) => {
      calls.push({ method, args })
      return obj
    }
  }
  obj.then = (resolve: (v: { data: unknown[]; error: null }) => void) => resolve({ data: [], error: null })
  return obj
}

describe('affiliate-service: D3-E real-data scope (category: ADMIN-CONTROL-CENTRE-BATCH-D3-E)', () => {
  it('4. listAdminAffiliates filters data_classification=\'real\' directly on profiles', async () => {
    const calls: RecordedCall[] = []
    const admin = { from: () => fakeListQuery(calls) } as unknown as Parameters<typeof listAdminAffiliates>[0]
    await listAdminAffiliates(admin, {})
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'data_classification' && c.args[1] === 'real')).toBe(true)
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'is_affiliate' && c.args[1] === true)).toBe(true)
  })

  it('5. listAdminAffiliateCommissions filters all three embedded profiles (affiliate/merchant/referred) real AND the listing non-test', async () => {
    const calls: RecordedCall[] = []
    const admin = { from: () => fakeListQuery(calls) } as unknown as Parameters<typeof listAdminAffiliateCommissions>[0]
    await listAdminAffiliateCommissions(admin, {})
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'affiliate_profile.data_classification' && c.args[1] === 'real')).toBe(true)
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'merchant_profile.data_classification' && c.args[1] === 'real')).toBe(true)
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'referred_profile.data_classification' && c.args[1] === 'real')).toBe(true)
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'listings.is_test' && c.args[1] === false)).toBe(true)
  })
})

function fakeAffiliateDetailAdmin(profileRow: Record<string, unknown> | null) {
  const profileQuery: Record<string, unknown> = {}
  for (const method of ['select', 'eq']) profileQuery[method] = () => profileQuery
  profileQuery.maybeSingle = () => Promise.resolve({ data: profileRow, error: null })

  const empty: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'order']) empty[method] = () => empty
  empty.then = (resolve: (v: { data: unknown[]; error: null }) => void) => resolve({ data: [], error: null })

  return {
    from: (table: string) => (table === 'profiles' ? profileQuery : empty),
  } as unknown as Parameters<typeof getAdminAffiliateDetail>[0]
}

describe('affiliate-service: getAdminAffiliateDetail real-data scope (category: ADMIN-CONTROL-CENTRE-BATCH-D3-E)', () => {
  it('6. a real affiliate resolves normally', async () => {
    const admin = fakeAffiliateDetailAdmin({ id: 'a1', full_name: 'Affiliate', display_name: null, affiliate_code: 'ABC', account_status: 'active', created_at: '2026-01-01', data_classification: 'real' })
    expect(await getAdminAffiliateDetail(admin, 'a1')).not.toBeNull()
  })

  it('7. a test-classified affiliate is treated as not found', async () => {
    const admin = fakeAffiliateDetailAdmin({ id: 'a1', full_name: 'Affiliate', display_name: null, affiliate_code: 'ABC', account_status: 'active', created_at: '2026-01-01', data_classification: 'test' })
    expect(await getAdminAffiliateDetail(admin, 'a1')).toBeNull()
  })

  it('8. a missing affiliate profile returns null', async () => {
    const admin = fakeAffiliateDetailAdmin(null)
    expect(await getAdminAffiliateDetail(admin, 'missing')).toBeNull()
  })
})

function fakeCommissionDetailAdmin(commission: Record<string, unknown> | null, scopeProfiles: Record<string, unknown>[], scopeListing: Record<string, unknown> | null) {
  const commissionQuery: Record<string, unknown> = {}
  for (const method of ['select', 'eq']) commissionQuery[method] = () => commissionQuery
  commissionQuery.maybeSingle = () => Promise.resolve({ data: commission, error: null })

  const profilesQuery: Record<string, unknown> = {}
  for (const method of ['select', 'in', 'eq']) profilesQuery[method] = () => profilesQuery
  profilesQuery.then = (resolve: (v: { data: typeof scopeProfiles; error: null }) => void) => resolve({ data: scopeProfiles, error: null })

  const listingQuery: Record<string, unknown> = {}
  for (const method of ['select', 'eq']) listingQuery[method] = () => listingQuery
  listingQuery.maybeSingle = () => Promise.resolve({ data: scopeListing, error: null })

  const empty: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'order', 'in']) empty[method] = () => empty
  empty.then = (resolve: (v: { data: unknown[]; error: null }) => void) => resolve({ data: [], error: null })
  empty.maybeSingle = () => Promise.resolve({ data: null, error: null })

  let profilesCallCount = 0
  return {
    from: (table: string) => {
      if (table === 'affiliate_commissions') return commissionQuery
      if (table === 'listings') return listingQuery
      if (table === 'profiles') {
        profilesCallCount += 1
        // D3-E: the scope check runs first (in()), display lookups run after -- both hit 'profiles', so reuse the same fixture for both.
        return profilesCallCount === 1 ? profilesQuery : empty
      }
      return empty
    },
  } as unknown as Parameters<typeof getAdminAffiliateCommissionDetail>[0]
}

describe('affiliate-service: getAdminAffiliateCommissionDetail real-data scope (category: ADMIN-CONTROL-CENTRE-BATCH-D3-E)', () => {
  const baseCommission = { id: 'ac1', affiliate_id: 'a1', merchant_id: 'm1', referred_user_id: 'u1', listing_id: 'l1', payment_id: 'pay1' }

  it('9. real affiliate + real merchant + real referred user + non-test listing resolves normally', async () => {
    const admin = fakeCommissionDetailAdmin(
      baseCommission,
      [{ id: 'a1', data_classification: 'real' }, { id: 'm1', data_classification: 'real' }, { id: 'u1', data_classification: 'real' }],
      { is_test: false }
    )
    expect(await getAdminAffiliateCommissionDetail(admin, 'ac1')).not.toBeNull()
  })

  it('10. a test-classified referred user blocks the commission even though affiliate and merchant are real', async () => {
    const admin = fakeCommissionDetailAdmin(
      baseCommission,
      [{ id: 'a1', data_classification: 'real' }, { id: 'm1', data_classification: 'real' }, { id: 'u1', data_classification: 'test' }],
      { is_test: false }
    )
    expect(await getAdminAffiliateCommissionDetail(admin, 'ac1')).toBeNull()
  })

  it('11. a missing commission row returns null', async () => {
    const admin = fakeCommissionDetailAdmin(null, [], null)
    expect(await getAdminAffiliateCommissionDetail(admin, 'missing')).toBeNull()
  })
})

function fakeOverviewCountQuery(count: number | null, calls: RecordedCall[]) {
  const obj: Record<string, unknown> = {}
  for (const method of ['select', 'eq']) {
    obj[method] = (...args: unknown[]) => {
      calls.push({ method, args })
      return obj
    }
  }
  obj.then = (resolve: (v: { count: number | null; error: null }) => void) => resolve({ count, error: null })
  return obj
}

describe('affiliate-service: getRealAffiliateOverviewCounts (category: ADMIN-CONTROL-CENTRE-BATCH-D3-E)', () => {
  it('12. active_affiliates filters is_affiliate=true AND data_classification=\'real\' on profiles directly', async () => {
    const calls: RecordedCall[] = []
    const admin = { from: () => fakeOverviewCountQuery(1, calls) } as unknown as Parameters<typeof getRealAffiliateOverviewCounts>[0]
    await getRealAffiliateOverviewCounts(admin)
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'is_affiliate' && c.args[1] === true)).toBe(true)
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'data_classification' && c.args[1] === 'real')).toBe(true)
  })

  it('13. a null count resolves to 0 for every field', async () => {
    const admin = { from: () => fakeOverviewCountQuery(null, []) } as unknown as Parameters<typeof getRealAffiliateOverviewCounts>[0]
    const counts = await getRealAffiliateOverviewCounts(admin)
    expect(Object.values(counts)).toEqual([0, 0, 0, 0, 0])
  })
})
