import { describe, it, expect, vi } from 'vitest'
import { listAdminSubscriptions, getAdminSubscriptionDetail, getRealSubscriptionOverviewCounts } from '../subscriptions-service'

vi.mock('@/lib/subscriptions/effective-plan', () => ({
  getEffectiveMerchantPlan: vi.fn().mockResolvedValue({ planId: 'starter', plan: null, subscription: null }),
}))
vi.mock('@/lib/subscriptions/entitlements', () => ({
  getPublicationUsage: vi.fn().mockResolvedValue({ activeCount: 0, limit: null, atLimit: false }),
}))

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

describe('subscriptions-service: listAdminSubscriptions real-data scope (category: ADMIN-CONTROL-CENTRE-BATCH-D3-E)', () => {
  it('1. filters the embedded merchant profile data_classification = \'real\'', async () => {
    const calls: RecordedCall[] = []
    const admin = { from: () => fakeListQuery(calls) } as unknown as Parameters<typeof listAdminSubscriptions>[0]
    await listAdminSubscriptions(admin, {})
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'profiles.data_classification' && c.args[1] === 'real')).toBe(true)
  })

  it('2. the real-data filter composes with an existing status filter', async () => {
    const calls: RecordedCall[] = []
    const admin = { from: () => fakeListQuery(calls) } as unknown as Parameters<typeof listAdminSubscriptions>[0]
    await listAdminSubscriptions(admin, { status: 'active' })
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'profiles.data_classification')).toBe(true)
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'status' && c.args[1] === 'active')).toBe(true)
  })

  it('3. zero real subscriptions returns an empty array without throwing', async () => {
    const admin = { from: () => fakeListQuery([]) } as unknown as Parameters<typeof listAdminSubscriptions>[0]
    const rows = await listAdminSubscriptions(admin, {})
    expect(rows).toEqual([])
  })
})

function fakeDetailAdmin(profileRow: Record<string, unknown> | null) {
  const profileQuery: Record<string, unknown> = {}
  for (const method of ['select', 'eq']) profileQuery[method] = () => profileQuery
  profileQuery.maybeSingle = () => Promise.resolve({ data: profileRow, error: null })

  const empty: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'order']) empty[method] = () => empty
  empty.then = (resolve: (v: { data: unknown[]; error: null }) => void) => resolve({ data: [], error: null })

  return {
    from: (table: string) => (table === 'profiles' ? profileQuery : empty),
  } as unknown as Parameters<typeof getAdminSubscriptionDetail>[0]
}

describe('subscriptions-service: getAdminSubscriptionDetail real-data scope (category: ADMIN-CONTROL-CENTRE-BATCH-D3-E)', () => {
  it('4. a real merchant resolves normally', async () => {
    const admin = fakeDetailAdmin({ id: 'm1', full_name: 'Merchant', display_name: null, account_status: 'active', data_classification: 'real' })
    const detail = await getAdminSubscriptionDetail(admin, 'm1')
    expect(detail).not.toBeNull()
  })

  it('5. a test-classified merchant is treated as not found', async () => {
    const admin = fakeDetailAdmin({ id: 'm1', full_name: 'Merchant', display_name: null, account_status: 'active', data_classification: 'test' })
    const detail = await getAdminSubscriptionDetail(admin, 'm1')
    expect(detail).toBeNull()
  })

  it('6. an unknown-classified merchant is treated as not found', async () => {
    const admin = fakeDetailAdmin({ id: 'm1', full_name: 'Merchant', display_name: null, account_status: 'active', data_classification: 'unknown' })
    const detail = await getAdminSubscriptionDetail(admin, 'm1')
    expect(detail).toBeNull()
  })

  it('7. a missing merchant profile returns null', async () => {
    const admin = fakeDetailAdmin(null)
    const detail = await getAdminSubscriptionDetail(admin, 'missing')
    expect(detail).toBeNull()
  })
})

function fakeCountQuery(count: number | null, calls: RecordedCall[]) {
  const obj: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'in', 'lte']) {
    obj[method] = (...args: unknown[]) => {
      calls.push({ method, args })
      return obj
    }
  }
  obj.then = (resolve: (v: { count: number | null; error: null }) => void) => resolve({ count, error: null })
  return obj
}

describe('subscriptions-service: getRealSubscriptionOverviewCounts (category: ADMIN-CONTROL-CENTRE-BATCH-D3-E)', () => {
  it('8. every count filters the embedded merchant profile data_classification = \'real\'', async () => {
    const calls: RecordedCall[] = []
    const admin = { from: () => fakeCountQuery(1, calls) } as unknown as Parameters<typeof getRealSubscriptionOverviewCounts>[0]
    await getRealSubscriptionOverviewCounts(admin)
    expect(calls.filter((c) => c.method === 'eq' && c.args[0] === 'profiles.data_classification' && c.args[1] === 'real').length).toBe(5)
  })

  it('9. a null count resolves to 0 for every field', async () => {
    const admin = { from: () => fakeCountQuery(null, []) } as unknown as Parameters<typeof getRealSubscriptionOverviewCounts>[0]
    const counts = await getRealSubscriptionOverviewCounts(admin)
    expect(Object.values(counts)).toEqual([0, 0, 0, 0, 0])
  })
})
