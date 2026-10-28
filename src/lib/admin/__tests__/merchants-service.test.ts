import { describe, it, expect, vi } from 'vitest'
import { listAdminMerchants } from '../merchants-service'

function chainable(result: { data?: unknown; error?: unknown }) {
  const obj: Record<string, unknown> = {
    select: () => obj,
    eq: () => obj,
    or: () => obj,
    order: () => obj,
    limit: () => obj,
    in: () => obj,
    then: (resolve: (v: typeof result) => void) => resolve(result),
  }
  return obj
}

const MERCHANTS = [
  { id: 'm1', full_name: 'Merchant One', display_name: null, role: 'merchant', kyc_status: 'approved', account_status: 'active', unity_score: 4.5, created_at: '2026-01-01T00:00:00Z' },
  { id: 'm2', full_name: 'Merchant Two', display_name: null, role: 'both', kyc_status: 'pending', account_status: 'active', unity_score: 3.0, created_at: '2026-01-02T00:00:00Z' },
]

describe('merchants-service: listAdminMerchants (category: ADMIN-CONTROL-CENTRE-BATCH-A1)', () => {
  it("1. the base query is scoped to role IN ('merchant','both') -- never plain renters", async () => {
    const inSpy = vi.fn()
    const admin = {
      from: (table: string) => {
        if (table === 'profiles') {
          return {
            select: () => ({
              in: (col: string, values: string[]) => {
                inSpy(col, values)
                return chainable({ data: MERCHANTS, error: null })
              },
            }),
          }
        }
        return chainable({ data: [], error: null })
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    await listAdminMerchants(admin, {})
    expect(inSpy).toHaveBeenCalledWith('role', ['merchant', 'both'])
  })

  it('2. an empty merchant page returns [] without attempting any batched count query', async () => {
    const listingsSpy = vi.fn()
    const admin = {
      from: (table: string) => {
        if (table === 'profiles') return { select: () => ({ in: () => chainable({ data: [], error: null }) }) }
        if (table === 'listings') listingsSpy()
        return chainable({ data: [], error: null })
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    const rows = await listAdminMerchants(admin, {})
    expect(rows).toEqual([])
    expect(listingsSpy).not.toHaveBeenCalled()
  })

  it('3. active listing counts and subscription plans are correctly attributed per merchant, defaulting to starter when no row exists', async () => {
    const admin = {
      from: (table: string) => {
        if (table === 'profiles') return { select: () => ({ in: () => chainable({ data: MERCHANTS, error: null }) }) }
        if (table === 'listings') {
          return chainable({
            data: [
              { id: 'l1', merchant_id: 'm1', status: 'active' },
              { id: 'l2', merchant_id: 'm1', status: 'draft' },
              { id: 'l3', merchant_id: 'm2', status: 'active' },
            ],
            error: null,
          })
        }
        if (table === 'listing_ownership_verification') return chainable({ data: [{ listing_id: 'l2', status: 'pending' }], error: null })
        if (table === 'merchant_payouts') return chainable({ data: [], error: null })
        if (table === 'merchant_subscriptions') return chainable({ data: [{ merchant_id: 'm1', current_plan_id: 'pro' }], error: null })
        throw new Error(`unexpected table: ${table}`)
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    const rows = await listAdminMerchants(admin, {})
    const m1 = rows.find((r) => r.id === 'm1')!
    const m2 = rows.find((r) => r.id === 'm2')!
    expect(m1.activeListingCount).toBe(1)
    expect(m1.pendingOwnershipCount).toBe(1) // l2 belongs to m1
    expect(m1.subscriptionPlanId).toBe('pro')
    expect(m2.activeListingCount).toBe(1)
    expect(m2.subscriptionPlanId).toBe('starter') // no merchant_subscriptions row -- defaults, never fabricated as "pro"
  })
})

interface RecordedCall {
  method: string
  args: unknown[]
}

function recordingChainable(result: { data?: unknown; error?: unknown }, calls: RecordedCall[]) {
  const obj: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'or', 'order', 'limit', 'in']) {
    obj[method] = (...args: unknown[]) => {
      calls.push({ method, args })
      return obj
    }
  }
  obj.then = (resolve: (v: typeof result) => void) => resolve(result)
  return obj
}

describe('merchants-service: D3-C real-data scope adoption (category: ADMIN-CONTROL-CENTRE-BATCH-D3-C)', () => {
  it('4. the profiles query filters on data_classification = \'real\' -- a merchant owned by a test or unknown profile is excluded at the query level, never fetched then filtered', async () => {
    const profileCalls: RecordedCall[] = []
    const admin = {
      from: (table: string) => {
        if (table === 'profiles') return recordingChainable({ data: [], error: null }, profileCalls)
        return recordingChainable({ data: [], error: null }, [])
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    await listAdminMerchants(admin, {})
    expect(profileCalls.some((c) => c.method === 'eq' && c.args[0] === 'data_classification' && c.args[1] === 'real')).toBe(true)
    expect(profileCalls.some((c) => c.method === 'in' && c.args[0] === 'role')).toBe(true)
  })

  it('5. the listings query underlying activeListingCount/pendingOwnershipCount requires is_test = false -- an is_test=true listing is excluded even for an already-real merchant (entity+owner rule, not owner alone)', async () => {
    const listingCalls: RecordedCall[] = []
    const admin = {
      from: (table: string) => {
        if (table === 'profiles') return { select: () => ({ in: () => recordingChainable({ data: MERCHANTS, error: null }, []) }) }
        if (table === 'listings') return recordingChainable({ data: [], error: null }, listingCalls)
        return recordingChainable({ data: [], error: null }, [])
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    await listAdminMerchants(admin, {})
    expect(listingCalls.some((c) => c.method === 'eq' && c.args[0] === 'is_test' && c.args[1] === false)).toBe(true)
  })

  it('6. search preserves real scope -- the data_classification filter and the search predicate are both applied to the same query, not search-then-filter', async () => {
    const profileCalls: RecordedCall[] = []
    const admin = {
      from: (table: string) => {
        if (table === 'profiles') return recordingChainable({ data: [], error: null }, profileCalls)
        return recordingChainable({ data: [], error: null }, [])
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    await listAdminMerchants(admin, { search: 'Acme' })
    const scopeIdx = profileCalls.findIndex((c) => c.method === 'eq' && c.args[0] === 'data_classification')
    const orIdx = profileCalls.findIndex((c) => c.method === 'or')
    expect(scopeIdx).toBeGreaterThanOrEqual(0)
    expect(orIdx).toBeGreaterThanOrEqual(0)
  })

  it('7. the real-data filter composes with an existing status filter, not replaces it', async () => {
    const profileCalls: RecordedCall[] = []
    const admin = {
      from: (table: string) => {
        if (table === 'profiles') return recordingChainable({ data: [], error: null }, profileCalls)
        return recordingChainable({ data: [], error: null }, [])
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    await listAdminMerchants(admin, { accountStatus: 'active' })
    expect(profileCalls.some((c) => c.method === 'eq' && c.args[0] === 'data_classification' && c.args[1] === 'real')).toBe(true)
    expect(profileCalls.some((c) => c.method === 'eq' && c.args[0] === 'account_status' && c.args[1] === 'active')).toBe(true)
  })
})
