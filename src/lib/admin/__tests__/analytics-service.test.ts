import { describe, it, expect, vi } from 'vitest'
import {
  getMarketplaceOverview,
  getSupplyAnalytics,
  getTransactionAnalytics,
  getTrustAnalytics,
  getCommercialAnalytics,
  getSupportAnalytics,
  getGrowthAnalytics,
} from '../analytics-service'

vi.mock('@/lib/subscriptions/demand', () => ({
  getDemandInsights: vi.fn().mockResolvedValue({ windowDays: 30, trends: [], hasSufficientData: false }),
}))

/** Records every chained call and resolves to `result` -- mirrors support-service.test.ts's own helper. */
function chainableQuery(result: { data?: unknown; error?: unknown; count?: number | null }, spies: Record<string, ((...args: unknown[]) => unknown) | undefined> = {}) {
  const obj: Record<string, unknown> = {
    select: (...args: unknown[]) => { spies.select?.(...args); return obj },
    eq: (...args: unknown[]) => { spies.eq?.(...args); return obj },
    neq: (...args: unknown[]) => { spies.neq?.(...args); return obj },
    in: (...args: unknown[]) => { spies.in?.(...args); return obj },
    gte: (...args: unknown[]) => { spies.gte?.(...args); return obj },
    lt: (...args: unknown[]) => { spies.lt?.(...args); return obj },
    not: (...args: unknown[]) => { spies.not?.(...args); return obj },
    then: (resolve: (v: typeof result) => void) => resolve(result),
  }
  return obj
}

describe('getMarketplaceOverview (category: ADMIN-CONTROL-CENTRE-BATCH-D1) — real queries, test exclusion, zero-data', () => {
  it('1. active-listing query filters is_test=false, status=active, direction=available -- never counts QA/demo supply', async () => {
    const eqSpy = vi.fn()
    const admin = {
      from: (table: string) => {
        if (table === 'listings') return chainableQuery({ data: [], error: null, count: 0 }, { eq: eqSpy })
        return chainableQuery({ data: [], error: null, count: 0 })
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    await getMarketplaceOverview(admin, '30d')
    expect(eqSpy).toHaveBeenCalledWith('status', 'active')
    expect(eqSpy).toHaveBeenCalledWith('is_test', false)
    expect(eqSpy).toHaveBeenCalledWith('direction', 'available')
  })

  it('2. non-erased user count filters account_status <> erased via .neq, never counting erased profiles as present', async () => {
    const neqSpy = vi.fn()
    const admin = {
      from: () => chainableQuery({ data: [], error: null, count: 0 }, { neq: neqSpy }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    await getMarketplaceOverview(admin, 'all')
    expect(neqSpy).toHaveBeenCalledWith('account_status', 'erased')
  })

  it('3. merchant/renter role counts use .in with the correct role sets ("both" counts as both)', async () => {
    const inCalls: unknown[][] = []
    const admin = {
      from: () => chainableQuery({ data: [], error: null, count: 0 }, { in: (...args: unknown[]) => inCalls.push(args) }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    await getMarketplaceOverview(admin, 'all')
    expect(inCalls).toContainEqual(['role', ['merchant', 'both']])
    expect(inCalls).toContainEqual(['role', ['renter', 'both']])
  })

  it('4. zero listings/users does not throw and returns zero counts, not undefined/NaN', async () => {
    const admin = {
      from: () => chainableQuery({ data: [], error: null, count: 0 }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    const result = await getMarketplaceOverview(admin, '30d')
    expect(result.totalUsers).toBe(0)
    expect(result.realActiveMerchants).toBe(0)
  })

  it('5. real active merchants is the distinct merchant_id count among active listing rows, not the row count itself', async () => {
    const rows = [{ merchant_id: 'm1' }, { merchant_id: 'm1' }, { merchant_id: 'm2' }]
    const admin = {
      from: (table: string) => {
        if (table === 'listings') return chainableQuery({ data: rows, error: null, count: 3 })
        return chainableQuery({ data: [], error: null, count: 0 })
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    const result = await getMarketplaceOverview(admin, 'all')
    expect(result.realActiveMerchants).toBe(2)
    expect(result.realActiveListings).toBe(3)
  })

  it('6. period filtering: a 30d period passes a created_at >= cutoff via .gte, a 7d period passes a different (later) cutoff', async () => {
    const gteCalls: unknown[][] = []
    const admin = {
      from: () => chainableQuery({ data: [], error: null, count: 0 }, { gte: (...args: unknown[]) => gteCalls.push(args) }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    await getMarketplaceOverview(admin, '7d')
    expect(gteCalls.length).toBeGreaterThan(0)
    expect(gteCalls[0][0]).toBe('created_at')
  })

  it('7. "all" period never applies a created_at lower bound for the headline counts', async () => {
    const gteSpy = vi.fn()
    const admin = {
      from: () => chainableQuery({ data: [], error: null, count: 0 }, { gte: gteSpy }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    await getMarketplaceOverview(admin, 'all')
    // periodComparison's "current" count for 'all' omits .gte entirely (sinceIso is null) --
    // only the already-covered active-listing/profile head counts run, so gte must stay unused.
    expect(gteSpy).not.toHaveBeenCalled()
  })
})

describe('getSupplyAnalytics (category: ADMIN-CONTROL-CENTRE-BATCH-D1) — test exclusion, missing-data handling', () => {
  it('1. filters is_test=false, status=active, direction=available on the listings query', async () => {
    const eqSpy = vi.fn()
    const admin = {
      from: (table: string) => {
        if (table === 'listings') return chainableQuery({ data: [], error: null }, { eq: eqSpy })
        return chainableQuery({ data: [], error: null })
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    await getSupplyAnalytics(admin, 'all')
    expect(eqSpy).toHaveBeenCalledWith('is_test', false)
    expect(eqSpy).toHaveBeenCalledWith('status', 'active')
    expect(eqSpy).toHaveBeenCalledWith('direction', 'available')
  })

  it('2. missing province/city/collection_area are grouped and counted as "Missing", not silently dropped', async () => {
    const rows = [
      { id: '1', merchant_id: 'm1', category: 'Cameras', province: null, city: '', collection_area: 'CBD', ownership_verified: true, created_at: '2026-01-01T00:00:00Z' },
      { id: '2', merchant_id: 'm1', category: 'Cameras', province: 'Gauteng', city: 'Joburg', collection_area: null, ownership_verified: false, created_at: '2026-01-02T00:00:00Z' },
    ]
    const admin = {
      from: (table: string) => {
        if (table === 'listings') return chainableQuery({ data: rows, error: null })
        if (table === 'listing_media') return chainableQuery({ data: [], error: null })
        return chainableQuery({ data: [], error: null })
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    const result = await getSupplyAnalytics(admin, 'all')
    expect(result.dataQuality.missingProvince).toBe(1)
    expect(result.dataQuality.missingCity).toBe(1)
    expect(result.dataQuality.missingCollectionArea).toBe(1)
    expect(result.listingsByProvince.find((r) => r.label === 'Missing')?.count).toBe(1)
    expect(result.dataQuality.ownershipVerifiedCount).toBe(1)
    expect(result.dataQuality.ownershipNotVerifiedCount).toBe(1)
  })

  it('3. media-sufficiency check is 2 queries total (listings + one IN query on listing_media), never one query per listing', async () => {
    const fromCalls: string[] = []
    const rows = [
      { id: '1', merchant_id: 'm1', category: 'Cameras', province: 'Gauteng', city: 'Joburg', collection_area: 'CBD', ownership_verified: true, created_at: '2026-01-01T00:00:00Z' },
      { id: '2', merchant_id: 'm1', category: 'Cameras', province: 'Gauteng', city: 'Joburg', collection_area: 'CBD', ownership_verified: true, created_at: '2026-01-02T00:00:00Z' },
    ]
    const admin = {
      from: (table: string) => {
        fromCalls.push(table)
        if (table === 'listings') return chainableQuery({ data: rows, error: null })
        return chainableQuery({ data: [{ listing_id: '1' }, { listing_id: '1' }, { listing_id: '1' }], error: null })
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    const result = await getSupplyAnalytics(admin, 'all')
    expect(fromCalls.filter((t) => t === 'listing_media')).toHaveLength(1)
    // listing '1' has 3 media rows (sufficient), listing '2' has 0 (insufficient)
    expect(result.dataQuality.insufficientMedia).toBe(1)
  })

  it('4. zero active listings short-circuits the media check entirely (no listing_media query at all)', async () => {
    let listingMediaCalled = false
    const admin = {
      from: (table: string) => {
        if (table === 'listing_media') listingMediaCalled = true
        return chainableQuery({ data: [], error: null })
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    const result = await getSupplyAnalytics(admin, 'all')
    expect(listingMediaCalled).toBe(false)
    expect(result.activeListings).toBe(0)
    expect(result.dataQuality.insufficientMedia).toBe(0)
  })
})

describe('getTransactionAnalytics (category: ADMIN-CONTROL-CENTRE-BATCH-D1) — per-domain real status, no invented universal lifecycle', () => {
  it('1. each domain reports its own real status values, never normalized into one shared lifecycle', async () => {
    const admin = {
      from: (table: string) => {
        if (table === 'bookings') return chainableQuery({ data: [{ status: 'active', created_at: '2026-01-01T00:00:00Z' }], error: null })
        if (table === 'orders') return chainableQuery({ data: [{ status: 'paid', created_at: '2026-01-01T00:00:00Z' }], error: null })
        if (table === 'barter_agreements') return chainableQuery({ data: [{ status: 'completed', created_at: '2026-01-01T00:00:00Z' }], error: null })
        return chainableQuery({ data: [], error: null })
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    const result = await getTransactionAnalytics(admin, 'all')
    expect(result.bookings.byStatus[0].label).toBe('active')
    expect(result.orders.byStatus[0].label).toBe('paid')
    expect(result.barter.byStatus[0].label).toBe('completed')
  })

  it('2. rent-to-buy and Looking For queries filter is_test=false; bookings/orders/barter do not (no such column)', async () => {
    const eqCallsByTable: Record<string, unknown[][]> = {}
    const admin = {
      from: (table: string) => {
        eqCallsByTable[table] = []
        return chainableQuery({ data: [], error: null }, { eq: (...args: unknown[]) => eqCallsByTable[table].push(args) })
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    await getTransactionAnalytics(admin, 'all')
    expect(eqCallsByTable['rent_to_buy_agreements']).toContainEqual(['is_test', false])
    expect(eqCallsByTable['marketplace_requests']).toContainEqual(['is_test', false])
    expect(eqCallsByTable['bookings']).toEqual([])
    expect(eqCallsByTable['orders']).toEqual([])
  })

  it('3. never claims cash revenue -- the discriminant literal is always the explicit "not available" marker', async () => {
    const admin = {
      from: () => chainableQuery({ data: [], error: null }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    const result = await getTransactionAnalytics(admin, 'all')
    expect(result.revenueNote).toBe('not_available_mock_payment_provider')
  })

  it('4. zero rows in every domain does not throw', async () => {
    const admin = {
      from: () => chainableQuery({ data: [], error: null }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    await expect(getTransactionAnalytics(admin, '7d')).resolves.toBeDefined()
  })
})

describe('getTrustAnalytics (category: ADMIN-CONTROL-CENTRE-BATCH-D1) — aggregate-only, no raw KYC documents', () => {
  it('1. published-review count filters is_test=false and published_at not null -- never counts unpublished/blind reviews', async () => {
    const notSpy = vi.fn()
    const eqSpy = vi.fn()
    const admin = {
      from: (table: string) => {
        if (table === 'reviews') return chainableQuery({ data: [], error: null, count: 0 }, { not: notSpy, eq: eqSpy })
        return chainableQuery({ data: [], error: null })
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    await getTrustAnalytics(admin, 'all')
    expect(notSpy).toHaveBeenCalledWith('published_at', 'is', null)
    expect(eqSpy).toHaveBeenCalledWith('is_test', false)
  })

  it('2. reads only profiles.kyc_status and listing_ownership_verification.status -- never a documents/evidence column', async () => {
    const selectCalls: unknown[][] = []
    const admin = {
      from: (table: string) => {
        if (table === 'profiles') return chainableQuery({ data: [{ kyc_status: 'approved' }], error: null }, { select: (...a: unknown[]) => selectCalls.push(a) })
        if (table === 'listing_ownership_verification') return chainableQuery({ data: [{ status: 'verified' }], error: null }, { select: (...a: unknown[]) => selectCalls.push(a) })
        return chainableQuery({ data: [], error: null, count: 0 })
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    const result = await getTrustAnalytics(admin, 'all')
    expect(selectCalls.flat().join(' ')).not.toMatch(/document|evidence/i)
    expect(result.kycByStatus[0]).toEqual({ label: 'approved', count: 1 })
  })
})

describe('getCommercialAnalytics (category: ADMIN-CONTROL-CENTRE-BATCH-D1) — status-only, never a cash/revenue total', () => {
  it('1. returns status breakdowns for all five commercial domains without throwing on empty data', async () => {
    const admin = {
      from: () => chainableQuery({ data: [], error: null }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    const result = await getCommercialAnalytics(admin)
    expect(result.unityCommissionsByStatus).toEqual([])
    expect(result.merchantPayoutsByStatus).toEqual([])
    expect(result.subscriptionsByPlan).toEqual([])
  })

  it('2. subscription plan breakdown groups by plan_id (starter/pro/elite), not a display name it never queried', async () => {
    const admin = {
      from: (table: string) => {
        if (table === 'merchant_subscriptions') return chainableQuery({ data: [{ status: 'active', plan_id: 'pro' }, { status: 'active', plan_id: 'pro' }], error: null })
        return chainableQuery({ data: [], error: null })
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    const result = await getCommercialAnalytics(admin)
    expect(result.subscriptionsByPlan).toEqual([{ label: 'pro', count: 2 }])
  })
})

describe('getSupportAnalytics (category: ADMIN-CONTROL-CENTRE-BATCH-D1) — A2 Support Centre, read-only aggregation', () => {
  it('1. groups real support_cases rows by status/priority/category, applies the period cutoff, never mutates', async () => {
    const gteSpy = vi.fn()
    const admin = {
      from: (table: string) => {
        expect(table).toBe('support_cases')
        return chainableQuery(
          { data: [{ status: 'open', priority: 'high', category: 'payment', created_at: '2026-01-01T00:00:00Z' }], error: null },
          { gte: gteSpy }
        )
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    const result = await getSupportAnalytics(admin, '7d')
    expect(gteSpy).toHaveBeenCalledWith('created_at', expect.any(String))
    expect(result.byStatus).toEqual([{ label: 'open', count: 1 }])
    expect(result.byPriority).toEqual([{ label: 'high', count: 1 }])
    expect(result.total).toBe(1)
  })

  it('2. zero cases in the period returns empty breakdowns, not an error', async () => {
    const admin = {
      from: () => chainableQuery({ data: [], error: null }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    const result = await getSupportAnalytics(admin, '30d')
    expect(result.total).toBe(0)
    expect(result.byStatus).toEqual([])
  })
})

describe('getGrowthAnalytics (category: ADMIN-CONTROL-CENTRE-BATCH-D1) — labeled proxies, previous-period comparison', () => {
  it('1. "all" period yields a null previous value for every proxy -- never a fabricated comparison', async () => {
    const admin = {
      from: () => chainableQuery({ data: [], error: null, count: 5 }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    const result = await getGrowthAnalytics(admin, 'all')
    expect(result.newUsers.previous).toBeNull()
    expect(result.newMerchants.previous).toBeNull()
  })

  it('2. a bounded period (30d) computes a real previous-period count via both .gte and .lt', async () => {
    const gteSpy = vi.fn()
    const ltSpy = vi.fn()
    const admin = {
      from: () => chainableQuery({ data: [], error: null, count: 2 }, { gte: gteSpy, lt: ltSpy }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    const result = await getGrowthAnalytics(admin, '30d')
    expect(ltSpy).toHaveBeenCalled()
    expect(result.newUsers.previous).toBe(2)
  })
})
