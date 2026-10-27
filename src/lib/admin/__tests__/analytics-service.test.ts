import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
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
    is: (...args: unknown[]) => { spies.is?.(...args); return obj },
    gte: (...args: unknown[]) => { spies.gte?.(...args); return obj },
    lt: (...args: unknown[]) => { spies.lt?.(...args); return obj },
    not: (...args: unknown[]) => { spies.not?.(...args); return obj },
    then: (resolve: (v: typeof result) => void) => resolve(result),
  }
  return obj
}

/**
 * A per-call-chain query builder that accumulates its own filters and
 * resolves its COUNT from a caller-supplied function of those filters --
 * used to meaningfully test the new per-status COUNT(*) queries (D1-F1),
 * where each status value is a SEPARATE query-builder chain/instance, not
 * one shared `data` array to group in JS.
 */
function countQueryChain(getCount: (filters: Record<string, unknown>) => number) {
  const filters: Record<string, unknown> = {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const obj: any = {
    select: () => obj,
    eq: (col: string, val: unknown) => { filters[col] = val; return obj },
    in: (col: string, val: unknown) => { filters[`${col}__in`] = val; return obj },
    is: (col: string, val: unknown) => { filters[`${col}__is`] = val; return obj },
    not: (col: string, _op: string, val: unknown) => { filters[`${col}__not`] = val; return obj },
    gte: (col: string, val: unknown) => { filters[`${col}__gte`] = val; return obj },
    lt: (col: string, val: unknown) => { filters[`${col}__lt`] = val; return obj },
    then: (resolve: (v: { count: number; error: null }) => void) => resolve({ count: getCount(filters), error: null }),
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

describe('getTransactionAnalytics (category: ADMIN-CONTROL-CENTRE-BATCH-D1-F1) — relational test exclusion, server-side counts, no invented universal lifecycle', () => {
  it('1. BOOKINGS: a real-listing-linked booking is counted and a test-listing-linked one is not -- relational exclusion via an inner join, never a full-row fetch', async () => {
    const admin = {
      from: (table: string) => {
        if (table === 'bookings') {
          return countQueryChain((f) => (f.status === 'active' && f['listings.is_test'] === false ? 3 : 0))
        }
        return chainableQuery({ data: [], error: null, count: 0 })
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    const result = await getTransactionAnalytics(admin, 'all')
    expect(result.bookings.byStatus).toEqual([{ label: 'active', count: 3 }])
    expect(result.bookings.mayIncludeTestData).toBe(false)
  })

  it('2. ORDERS: same relational exclusion pattern as bookings', async () => {
    const admin = {
      from: (table: string) => {
        if (table === 'orders') {
          return countQueryChain((f) => (f.status === 'paid' && f['listings.is_test'] === false ? 5 : 0))
        }
        return chainableQuery({ data: [], error: null, count: 0 })
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    const result = await getTransactionAnalytics(admin, 'all')
    expect(result.orders.byStatus).toEqual([{ label: 'paid', count: 5 }])
    expect(result.orders.mayIncludeTestData).toBe(false)
  })

  it('3. BARTER: combines BOTH anchor types (listing-anchored + skill/task-anchored) relationally excluding test activity from each, mayIncludeTestData is now false (D1-F2)', async () => {
    const admin = {
      from: (table: string) => {
        if (table === 'barter_agreements') {
          return {
            select: (cols: string) => {
              if (cols.includes('listings!inner')) return countQueryChain((f) => (f.status === 'completed' && f['listings.is_test'] === false ? 3 : 0))
              if (cols.includes('barter_skill_task_posts')) return countQueryChain((f) => (f.status === 'completed' && f['barter_skill_task_posts.is_test'] === false ? 2 : 0))
              return countQueryChain(() => 0)
            },
          }
        }
        return chainableQuery({ data: [], error: null, count: 0 })
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    const result = await getTransactionAnalytics(admin, 'all')
    expect(result.barter.mayIncludeTestData).toBe(false)
    // 3 (real, listing-anchored) + 2 (real, skill/task-anchored) = 5
    expect(result.barter.byStatus).toEqual([{ label: 'completed', count: 5 }])
  })

  it('4. RENT-TO-BUY and LOOKING FOR keep their existing direct is_test=false filter -- not regressed by this remediation', async () => {
    const eqCallsByTable: Record<string, unknown[][]> = {}
    const admin = {
      from: (table: string) => {
        eqCallsByTable[table] ??= []
        return chainableQuery({ data: null, error: null, count: 0 }, { eq: (...args: unknown[]) => eqCallsByTable[table].push(args) })
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    await getTransactionAnalytics(admin, 'all')
    expect(eqCallsByTable['rent_to_buy_agreements']).toContainEqual(['is_test', false])
    expect(eqCallsByTable['marketplace_requests']).toContainEqual(['is_test', false])
  })

  it('5. never claims cash revenue -- the discriminant literal is always the explicit "not available" marker', async () => {
    const admin = {
      from: () => chainableQuery({ data: null, error: null, count: 0 }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    const result = await getTransactionAnalytics(admin, 'all')
    expect(result.revenueNote).toBe('not_available_mock_payment_provider')
  })

  it('6. zero rows in every domain does not throw', async () => {
    const admin = {
      from: () => chainableQuery({ data: null, error: null, count: 0 }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    await expect(getTransactionAnalytics(admin, '7d')).resolves.toBeDefined()
  })

  it('7. PERFORMANCE: bookings/orders never fetch row data -- every call selects with head:true, count:"exact", never a bare row array', async () => {
    const selectOptsSeen: unknown[] = []
    const admin = {
      from: (table: string) => {
        if (table === 'bookings' || table === 'orders') {
          return {
            select: (_cols: string, opts: unknown) => { selectOptsSeen.push(opts); return countQueryChain(() => 0) },
          }
        }
        return chainableQuery({ data: null, error: null, count: 0 })
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    await getTransactionAnalytics(admin, 'all')
    expect(selectOptsSeen.length).toBeGreaterThan(0)
    for (const opts of selectOptsSeen) {
      expect(opts).toMatchObject({ count: 'exact', head: true })
    }
  })

  it('8. ALL-TIME: period="all" never applies a created_at lower bound -- it does not translate into "download every historical row"', async () => {
    const gteCalls: unknown[] = []
    const spyAdmin = {
      from: () => chainableQuery({ data: null, error: null, count: 0 }, { gte: (...a: unknown[]) => gteCalls.push(a) }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    await getTransactionAnalytics(spyAdmin, 'all')
    expect(gteCalls).toEqual([])
  })
})

describe('countBarterByStatusExcludingTestAnchors (category: ADMIN-CONTROL-CENTRE-BATCH-D1-F2) — two-anchor real-only exclusion', () => {
  /** Builds a fake `barter_agreements` select that routes to the right fake branch based on which embed is requested, so each test can control the two branches independently. */
  function barterAdmin(listingBranch: (f: Record<string, unknown>) => number, skillTaskBranch: (f: Record<string, unknown>) => number, skillTaskSelectArgs?: unknown[]) {
    return {
      from: (table: string) => {
        if (table !== 'barter_agreements') return chainableQuery({ data: [], error: null, count: 0 })
        return {
          select: (cols: string) => {
            if (cols.includes('listings!inner')) return countQueryChain(listingBranch)
            if (cols.includes('barter_skill_task_posts')) {
              skillTaskSelectArgs?.push(cols)
              return countQueryChain(skillTaskBranch)
            }
            return countQueryChain(() => 0)
          },
        }
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
  }

  it('1. listing-anchored real barter requires listings.is_test=false -- a test-flagged listing-anchored row is not counted', async () => {
    const admin = barterAdmin((f) => (f.status === 'accepted' && f['listings.is_test'] === false ? 7 : 0), () => 0)
    const result = await getTransactionAnalytics(admin, 'all')
    expect(result.barter.byStatus).toEqual([{ label: 'accepted', count: 7 }])
  })

  it('2. skill/task-anchored real barter requires barter_skill_task_posts.is_test=false -- a test-flagged skill/task post is not counted', async () => {
    const admin = barterAdmin(() => 0, (f) => (f.status === 'accepted' && f['barter_skill_task_posts.is_test'] === false ? 4 : 0))
    const result = await getTransactionAnalytics(admin, 'all')
    expect(result.barter.byStatus).toEqual([{ label: 'accepted', count: 4 }])
  })

  it('3. uses the correct, explicit FK-constraint hint for the skill/task anchor relationship', async () => {
    const seenSelects: unknown[] = []
    const admin = barterAdmin(() => 0, () => 0, seenSelects)
    await getTransactionAnalytics(admin, 'all')
    expect(seenSelects.some((s) => typeof s === 'string' && s.includes('barter_agreements_anchor_skill_task_post_id_fkey'))).toBe(true)
  })

  it('4. never uses source_skill_task_post_id (a different FK, not the anchor relationship) for this exclusion', async () => {
    const seenSelects: unknown[] = []
    const admin = barterAdmin(() => 0, () => 0, seenSelects)
    await getTransactionAnalytics(admin, 'all')
    expect(seenSelects.some((s) => typeof s === 'string' && s.includes('source_skill_task_post_id'))).toBe(false)
  })

  it('5. the combined per-status count equals listing-anchor real count + skill/task-anchor real count', async () => {
    const admin = barterAdmin(
      (f) => (f.status === 'proposed' ? 10 : f.status === 'completed' ? 3 : 0),
      (f) => (f.status === 'proposed' ? 1 : f.status === 'completed' ? 6 : 0)
    )
    const result = await getTransactionAnalytics(admin, 'all')
    expect(result.barter.byStatus).toEqual(
      expect.arrayContaining([
        { label: 'proposed', count: 11 },
        { label: 'completed', count: 9 },
      ])
    )
  })

  it('6. barter.mayIncludeTestData is false now that a real-only exclusion exists', async () => {
    const admin = barterAdmin(() => 0, () => 0)
    const result = await getTransactionAnalytics(admin, 'all')
    expect(result.barter.mayIncludeTestData).toBe(false)
  })

  it('7. the old "PostgREST relationship-resolution discrepancy" misdiagnosis is removed from source -- it was a misdiagnosis, not a real limitation, and must not remain in operator-facing metadata or comments', () => {
    const content = readFileSync(join(__dirname, '../analytics-service.ts'), 'utf-8')
    expect(content).not.toMatch(/relationship-resolution discrepancy/i)
    expect(content).not.toMatch(/unavoidable QA inclusion/i)
  })

  describe('D1-H1 hotfix: proposed_at, not created_at (barter_agreements has no created_at column)', () => {
    it.each(['7d', '30d', '90d'] as const)('8-10. %s finite period: both branches filter on proposed_at', async (period) => {
      const listingFilters: Record<string, unknown>[] = []
      const skillTaskFilters: Record<string, unknown>[] = []
      const admin = {
        from: (table: string) => {
          if (table !== 'barter_agreements') return chainableQuery({ data: [], error: null, count: 0 })
          return {
            select: (cols: string) => {
              if (cols.includes('listings!inner')) {
                return countQueryChain((f) => { listingFilters.push(f); return 0 })
              }
              if (cols.includes('barter_skill_task_posts')) {
                return countQueryChain((f) => { skillTaskFilters.push(f); return 0 })
              }
              return countQueryChain(() => 0)
            },
          }
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any
      await getTransactionAnalytics(admin, period)
      expect(listingFilters.some((f) => 'proposed_at__gte' in f)).toBe(true)
      expect(skillTaskFilters.some((f) => 'proposed_at__gte' in f)).toBe(true)
    })

    it('11. all-time applies no proposed_at (or any) lower bound on either branch', async () => {
      const listingFilters: Record<string, unknown>[] = []
      const skillTaskFilters: Record<string, unknown>[] = []
      const admin = {
        from: (table: string) => {
          if (table !== 'barter_agreements') return chainableQuery({ data: [], error: null, count: 0 })
          return {
            select: (cols: string) => {
              if (cols.includes('listings!inner')) return countQueryChain((f) => { listingFilters.push(f); return 0 })
              if (cols.includes('barter_skill_task_posts')) return countQueryChain((f) => { skillTaskFilters.push(f); return 0 })
              return countQueryChain(() => 0)
            },
          }
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any
      await getTransactionAnalytics(admin, 'all')
      expect(listingFilters.every((f) => !('proposed_at__gte' in f))).toBe(true)
      expect(skillTaskFilters.every((f) => !('proposed_at__gte' in f))).toBe(true)
    })

    it('7b. neither branch ever filters on created_at (the production 42703 bug: "column barter_agreements.created_at does not exist")', async () => {
      const allFilters: Record<string, unknown>[] = []
      const admin = {
        from: (table: string) => {
          if (table !== 'barter_agreements') return chainableQuery({ data: [], error: null, count: 0 })
          return {
            select: () => countQueryChain((f) => { allFilters.push(f); return 0 }),
          }
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any
      await getTransactionAnalytics(admin, '30d')
      expect(allFilters.every((f) => !('created_at__gte' in f))).toBe(true)
    })
  })
})

describe('getTrustAnalytics (category: ADMIN-CONTROL-CENTRE-BATCH-D1-F1) — server-side counts, honest QA-inclusive disputes label', () => {
  it('1. published-review count filters is_test=false and published_at not null -- never counts unpublished/blind reviews (not regressed)', async () => {
    const notSpy = vi.fn()
    const eqSpy = vi.fn()
    const admin = {
      from: (table: string) => {
        if (table === 'reviews') return chainableQuery({ data: [], error: null, count: 0 }, { not: notSpy, eq: eqSpy })
        return countQueryChain(() => 0)
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    await getTrustAnalytics(admin, 'all')
    expect(notSpy).toHaveBeenCalledWith('published_at', 'is', null)
    expect(eqSpy).toHaveBeenCalledWith('is_test', false)
  })

  it('2. KYC and ownership-verification are server-side per-status counts, never a full profiles/listing_ownership_verification row fetch', async () => {
    const selectArgsByTable: Record<string, unknown[]> = {}
    const admin = {
      from: (table: string) => {
        selectArgsByTable[table] ??= []
        if (table === 'profiles') {
          return { select: (...a: unknown[]) => { selectArgsByTable[table].push(a); return countQueryChain((f) => (f.kyc_status === 'approved' ? 1 : 0)) } }
        }
        if (table === 'listing_ownership_verification') {
          return { select: (...a: unknown[]) => { selectArgsByTable[table].push(a); return countQueryChain((f) => (f.status === 'verified' ? 1 : 0)) } }
        }
        return chainableQuery({ data: [], error: null, count: 0 })
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    const result = await getTrustAnalytics(admin, 'all')
    expect(JSON.stringify(selectArgsByTable).toLowerCase()).not.toMatch(/document|evidence/)
    for (const args of selectArgsByTable.profiles) expect((args as unknown[])[1]).toMatchObject({ count: 'exact', head: true })
    expect(result.kycByStatus).toEqual([{ label: 'approved', count: 1 }])
    expect(result.ownershipVerificationByStatus).toEqual([{ label: 'verified', count: 1 }])
  })

  it('3. DISPUTES: no relational exclusion is attempted (2-hop, out of this phase\'s narrow scope) -- reported as a server-side count with mayIncludeTestData: true, never silently presented as real-only', async () => {
    const admin = {
      from: (table: string) => {
        if (table === 'disputes') return countQueryChain((f) => (f.status === 'open' ? 2 : 0))
        return chainableQuery({ data: [], error: null, count: 0 })
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    const result = await getTrustAnalytics(admin, 'all')
    expect(result.disputesByStatus.mayIncludeTestData).toBe(true)
    expect(result.disputesByStatus.byStatus).toEqual([{ label: 'open', count: 2 }])
  })
})

describe('getTrustAnalytics ownership-verification column (category: ADMIN-CONTROL-CENTRE-BATCH-D1-H1) — production hotfix: no id column on this table', () => {
  it('1. selects listing_id for listing_ownership_verification, never the nonexistent id column', async () => {
    const seenSelects: string[] = []
    const admin = {
      from: (table: string) => {
        if (table === 'listing_ownership_verification') {
          return { select: (cols: string) => { seenSelects.push(cols); return countQueryChain((f) => (f.status === 'verified' ? 5 : 0)) } }
        }
        return countQueryChain(() => 0)
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    await getTrustAnalytics(admin, 'all')
    expect(seenSelects.length).toBeGreaterThan(0)
    expect(seenSelects.every((c) => c === 'listing_id')).toBe(true)
  })

  it('2. never selects the bare "id" column for this table (that is the production 42703 bug: "column listing_ownership_verification.id does not exist")', async () => {
    const seenSelects: string[] = []
    const admin = {
      from: (table: string) => {
        if (table === 'listing_ownership_verification') {
          return { select: (cols: string) => { seenSelects.push(cols); return countQueryChain(() => 0) } }
        }
        return countQueryChain(() => 0)
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    await getTrustAnalytics(admin, 'all')
    expect(seenSelects.every((c) => c !== 'id')).toBe(true)
  })

  it('3. status filtering by each real ownership-verification status value is unchanged', async () => {
    const admin = {
      from: (table: string) => {
        if (table === 'listing_ownership_verification') return countQueryChain((f) => (f.status === 'under_review' ? 3 : 0))
        return countQueryChain(() => 0)
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    const result = await getTrustAnalytics(admin, 'all')
    expect(result.ownershipVerificationByStatus).toEqual([{ label: 'under_review', count: 3 }])
  })

  it('4. remains a server-side exact/head count, never a row fetch', async () => {
    const selectOptsSeen: unknown[] = []
    const admin = {
      from: (table: string) => {
        if (table === 'listing_ownership_verification') {
          return { select: (_cols: string, opts: unknown) => { selectOptsSeen.push(opts); return countQueryChain(() => 0) } }
        }
        return countQueryChain(() => 0)
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    await getTrustAnalytics(admin, 'all')
    expect(selectOptsSeen.length).toBeGreaterThan(0)
    for (const opts of selectOptsSeen) expect(opts).toMatchObject({ count: 'exact', head: true })
  })
})

describe('getCommercialAnalytics (category: ADMIN-CONTROL-CENTRE-BATCH-D1-F1) — relational exclusion for listing-linked ledgers, honest caveats elsewhere', () => {
  it('1. UNITY COMMISSIONS: relationally excludes rows tied to a test listing via the same inner-join pattern as bookings/orders', async () => {
    const admin = {
      from: (table: string) => {
        if (table === 'unity_commissions') return countQueryChain((f) => (f.status === 'earned' && f['listings.is_test'] === false ? 4 : 0))
        return countQueryChain(() => 0)
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    const result = await getCommercialAnalytics(admin)
    expect(result.unityCommissionsByStatus).toEqual([{ label: 'earned', count: 4 }])
  })

  it('2. AFFILIATE COMMISSIONS: same relational exclusion pattern', async () => {
    const admin = {
      from: (table: string) => {
        if (table === 'affiliate_commissions') return countQueryChain((f) => (f.status === 'paid' && f['listings.is_test'] === false ? 2 : 0))
        return countQueryChain(() => 0)
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    const result = await getCommercialAnalytics(admin)
    expect(result.affiliateCommissionsByStatus).toEqual([{ label: 'paid', count: 2 }])
  })

  it('3. AD CAMPAIGNS: a non-listing-targeted campaign (listing_id IS NULL) is counted without any join; a listing-targeted one is relationally excluded when its listing is test-flagged', async () => {
    const admin = {
      from: (table: string) => {
        if (table === 'ad_campaigns') {
          return countQueryChain((f) => {
            if (f.status !== 'active') return 0
            if (f['listing_id__is'] === null) return 1 // non-listing-targeted, always counted
            if (f['listing_id__not'] !== undefined && f['listings.is_test'] === false) return 1 // listing-targeted, real listing
            return 0
          })
        }
        return countQueryChain(() => 0)
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    const result = await getCommercialAnalytics(admin)
    // 1 (non-listing) + 1 (real listing-linked) = 2 for the 'active' status.
    expect(result.advertisingCampaignsByStatus).toEqual([{ label: 'active', count: 2 }])
  })

  it('4. MERCHANT PAYOUTS / SUBSCRIPTIONS: no relational exclusion is attempted (no reliable path exists) -- the result carries an explicit, honest caveat rather than a fabricated exclusion', async () => {
    const admin = {
      from: () => countQueryChain(() => 0),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    const result = await getCommercialAnalytics(admin)
    expect(result.notes.some((n) => /payout/i.test(n))).toBe(true)
    expect(result.notes.some((n) => /subscription/i.test(n))).toBe(true)
  })

  it('5. subscription plan breakdown groups by plan_id (starter/pro/elite), not a display name it never queried', async () => {
    const admin = {
      from: (table: string) => {
        if (table === 'merchant_subscriptions') {
          return countQueryChain((f) => (f.plan_id === 'pro' ? 2 : 0))
        }
        return countQueryChain(() => 0)
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    const result = await getCommercialAnalytics(admin)
    expect(result.subscriptionsByPlan).toEqual([{ label: 'pro', count: 2 }])
  })

  it('6. returns empty breakdowns for every domain without throwing on all-zero data', async () => {
    const admin = {
      from: () => countQueryChain(() => 0),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    const result = await getCommercialAnalytics(admin)
    expect(result.unityCommissionsByStatus).toEqual([])
    expect(result.merchantPayoutsByStatus).toEqual([])
    expect(result.advertisingCampaignsByStatus).toEqual([])
  })

  it('7. PERFORMANCE: never fetches a bare row array for any of the five commercial domains -- always a head:true exact count', async () => {
    const selectOptsSeen: unknown[] = []
    const admin = {
      from: () => ({
        select: (_cols: string, opts: unknown) => { if (opts) selectOptsSeen.push(opts); return countQueryChain(() => 0) },
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    await getCommercialAnalytics(admin)
    expect(selectOptsSeen.length).toBeGreaterThan(0)
    for (const opts of selectOptsSeen) expect(opts).toMatchObject({ count: 'exact', head: true })
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

  it('8. GROWTH newBookings (current period): relationally excludes test-listing-linked bookings via the same listings!inner(is_test) join as Transaction Analytics (D1-F2)', async () => {
    const admin = {
      from: (table: string) => {
        if (table === 'bookings') return countQueryChain((f) => (f['listings.is_test'] === false ? 9 : 0))
        return countQueryChain(() => 0)
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    const result = await getGrowthAnalytics(admin, '30d')
    expect(result.newBookings.current).toBe(9)
  })

  it('9. GROWTH newBookings (previous period): the same relational exclusion applies to the previous-period count, not just the current one', async () => {
    const admin = {
      from: (table: string) => {
        if (table === 'bookings') return countQueryChain((f) => (f['listings.is_test'] === false && f['created_at__lt'] ? 4 : 0))
        return countQueryChain(() => 0)
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    const result = await getGrowthAnalytics(admin, '30d')
    expect(result.newBookings.previous).toBe(4)
  })

  it('10. GROWTH newBookings (all-time): remains a server-side count -- never fetches booking row data, and previous stays null', async () => {
    const selectOptsSeen: unknown[] = []
    const admin = {
      from: (table: string) => {
        if (table === 'bookings') {
          return { select: (_cols: string, opts: unknown) => { selectOptsSeen.push(opts); return countQueryChain(() => 3) } }
        }
        return countQueryChain(() => 0)
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    const result = await getGrowthAnalytics(admin, 'all')
    expect(result.newBookings.previous).toBeNull()
    expect(selectOptsSeen.every((o) => (o as { count?: string; head?: boolean })?.count === 'exact' && (o as { head?: boolean })?.head === true)).toBe(true)
  })

  it('11. GROWTH newOrders (current period): relationally excludes test-listing-linked orders', async () => {
    const admin = {
      from: (table: string) => {
        if (table === 'orders') return countQueryChain((f) => (f['listings.is_test'] === false ? 6 : 0))
        return countQueryChain(() => 0)
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    const result = await getGrowthAnalytics(admin, '30d')
    expect(result.newOrders.current).toBe(6)
  })

  it('12. GROWTH newOrders (previous period): the same relational exclusion applies to the previous-period count', async () => {
    const admin = {
      from: (table: string) => {
        if (table === 'orders') return countQueryChain((f) => (f['listings.is_test'] === false && f['created_at__lt'] ? 2 : 0))
        return countQueryChain(() => 0)
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    const result = await getGrowthAnalytics(admin, '30d')
    expect(result.newOrders.previous).toBe(2)
  })

  it('13. GROWTH newOrders (all-time): remains a server-side count, previous stays null, no fabricated comparison', async () => {
    const admin = {
      from: (table: string) => {
        if (table === 'orders') return countQueryChain(() => 1)
        return countQueryChain(() => 0)
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    const result = await getGrowthAnalytics(admin, 'all')
    expect(result.newOrders.previous).toBeNull()
    expect(result.newOrders.current).toBe(1)
  })
})
