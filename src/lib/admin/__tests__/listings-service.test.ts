import { describe, it, expect } from 'vitest'
import { getRealListingOverviewCounts } from '../listings-service'

interface RecordedCall {
  method: string
  args: unknown[]
}

function fakeCountQuery(count: number | null, calls: RecordedCall[]) {
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

describe('listings-service: getRealListingOverviewCounts (category: ADMIN-CONTROL-CENTRE-BATCH-D3-D-F1)', () => {
  it('1. both counts filter is_test=false and the embedded merchant profile data_classification=\'real\'', async () => {
    const calls: RecordedCall[] = []
    const admin = { from: () => fakeCountQuery(5, calls) } as unknown as Parameters<typeof getRealListingOverviewCounts>[0]
    await getRealListingOverviewCounts(admin)
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'is_test' && c.args[1] === false)).toBe(true)
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'profiles.data_classification' && c.args[1] === 'real')).toBe(true)
  })

  it('2. active and suspended are each scoped by their own status filter', async () => {
    const calls: RecordedCall[] = []
    const admin = { from: () => fakeCountQuery(1, calls) } as unknown as Parameters<typeof getRealListingOverviewCounts>[0]
    await getRealListingOverviewCounts(admin)
    expect(calls.filter((c) => c.method === 'eq' && c.args[0] === 'status' && c.args[1] === 'active')).toHaveLength(1)
    expect(calls.filter((c) => c.method === 'eq' && c.args[0] === 'status' && c.args[1] === 'suspended')).toHaveLength(1)
  })

  it('3. a null count resolves to 0, never undefined/NaN', async () => {
    const admin = { from: () => fakeCountQuery(null, []) } as unknown as Parameters<typeof getRealListingOverviewCounts>[0]
    const counts = await getRealListingOverviewCounts(admin)
    expect(counts.activeListings).toBe(0)
    expect(counts.suspendedListings).toBe(0)
  })

  it('4. returns whatever the scoped count reports, never fabricated', async () => {
    const admin = { from: () => fakeCountQuery(42, []) } as unknown as Parameters<typeof getRealListingOverviewCounts>[0]
    const counts = await getRealListingOverviewCounts(admin)
    expect(counts.activeListings).toBe(42)
    expect(counts.suspendedListings).toBe(42)
  })
})
