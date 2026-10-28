import { describe, it, expect } from 'vitest'
import { listAdminRentToBuyAgreements, getAdminRentToBuyAgreementDetail, getRealRentToBuyOverviewCounts } from '../rent-to-buy-service'

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

describe('rent-to-buy-service: listAdminRentToBuyAgreements real-data scope (category: ADMIN-CONTROL-CENTRE-BATCH-D3-D)', () => {
  it('1. filters is_test = false and both merchant/customer embedded profile data_classification = \'real\'', async () => {
    const calls: RecordedCall[] = []
    const admin = { from: () => fakeListQuery(calls) } as unknown as Parameters<typeof listAdminRentToBuyAgreements>[0]
    await listAdminRentToBuyAgreements(admin, {})
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'is_test' && c.args[1] === false)).toBe(true)
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'merchant_profile.data_classification' && c.args[1] === 'real')).toBe(true)
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'customer_profile.data_classification' && c.args[1] === 'real')).toBe(true)
  })

  it('2. the real-data filter composes with an existing status filter', async () => {
    const calls: RecordedCall[] = []
    const admin = { from: () => fakeListQuery(calls) } as unknown as Parameters<typeof listAdminRentToBuyAgreements>[0]
    await listAdminRentToBuyAgreements(admin, { status: 'active' })
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'merchant_profile.data_classification')).toBe(true)
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'status' && c.args[1] === 'active')).toBe(true)
  })

  it('3. zero real agreements returns an empty array without throwing', async () => {
    const admin = { from: () => fakeListQuery([]) } as unknown as Parameters<typeof listAdminRentToBuyAgreements>[0]
    const rows = await listAdminRentToBuyAgreements(admin, {})
    expect(rows).toEqual([])
  })
})

function fakeRtbDetailAdmin(agreement: Record<string, unknown> | null, profileRows: Record<string, unknown>[]) {
  const agreementQuery: Record<string, unknown> = {}
  for (const method of ['select', 'eq']) agreementQuery[method] = () => agreementQuery
  agreementQuery.maybeSingle = () => Promise.resolve({ data: agreement, error: null })

  const profilesQuery: Record<string, unknown> = {}
  for (const method of ['select', 'in', 'eq']) profilesQuery[method] = () => profilesQuery
  profilesQuery.then = (resolve: (v: { data: typeof profileRows; error: null }) => void) => resolve({ data: profileRows, error: null })
  profilesQuery.maybeSingle = () => Promise.resolve({ data: profileRows[0] ?? null, error: null })

  const empty: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'order']) empty[method] = () => empty
  empty.then = (resolve: (v: { data: unknown[]; error: null }) => void) => resolve({ data: [], error: null })
  empty.maybeSingle = () => Promise.resolve({ data: null, error: null })

  return {
    from: (table: string) => {
      if (table === 'rent_to_buy_agreements') return agreementQuery
      if (table === 'profiles') return profilesQuery
      return empty
    },
  } as unknown as Parameters<typeof getAdminRentToBuyAgreementDetail>[0]
}

describe('rent-to-buy-service: getAdminRentToBuyAgreementDetail real-data scope (category: ADMIN-CONTROL-CENTRE-BATCH-D3-D)', () => {
  const baseAgreement = { id: 'rtb1', merchant_id: 'm1', customer_id: 'c1', listing_id: 'l1', is_test: false }

  it('4. real merchant + real customer + is_test=false resolves normally', async () => {
    const admin = fakeRtbDetailAdmin(baseAgreement, [
      { id: 'm1', data_classification: 'real' },
      { id: 'c1', data_classification: 'real' },
    ])
    const detail = await getAdminRentToBuyAgreementDetail(admin, 'rtb1')
    expect(detail).not.toBeNull()
  })

  it('5. is_test=true blocks the agreement even when both participants are real', async () => {
    const admin = fakeRtbDetailAdmin({ ...baseAgreement, is_test: true }, [
      { id: 'm1', data_classification: 'real' },
      { id: 'c1', data_classification: 'real' },
    ])
    const detail = await getAdminRentToBuyAgreementDetail(admin, 'rtb1')
    expect(detail).toBeNull()
  })

  it('6. a test-classified customer blocks the agreement even though the merchant is real', async () => {
    const admin = fakeRtbDetailAdmin(baseAgreement, [
      { id: 'm1', data_classification: 'real' },
      { id: 'c1', data_classification: 'test' },
    ])
    const detail = await getAdminRentToBuyAgreementDetail(admin, 'rtb1')
    expect(detail).toBeNull()
  })

  it('7. a missing agreement row returns null', async () => {
    const admin = fakeRtbDetailAdmin(null, [])
    const detail = await getAdminRentToBuyAgreementDetail(admin, 'missing')
    expect(detail).toBeNull()
  })
})

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

describe('rent-to-buy-service: getRealRentToBuyOverviewCounts (category: ADMIN-CONTROL-CENTRE-BATCH-D3-D-F1)', () => {
  it('8. every count filters is_test=false and both embedded merchant/customer profile data_classification=\'real\'', async () => {
    const calls: RecordedCall[] = []
    const admin = { from: () => fakeCountQuery(1, calls) } as unknown as Parameters<typeof getRealRentToBuyOverviewCounts>[0]
    await getRealRentToBuyOverviewCounts(admin)
    expect(calls.filter((c) => c.method === 'eq' && c.args[0] === 'is_test' && c.args[1] === false).length).toBe(5)
    expect(calls.filter((c) => c.method === 'eq' && c.args[0] === 'merchant_profile.data_classification' && c.args[1] === 'real').length).toBe(5)
    expect(calls.filter((c) => c.method === 'eq' && c.args[0] === 'customer_profile.data_classification' && c.args[1] === 'real').length).toBe(5)
  })

  it('9. return_required is scoped by possession_status, not status', async () => {
    const calls: RecordedCall[] = []
    const admin = { from: () => fakeCountQuery(1, calls) } as unknown as Parameters<typeof getRealRentToBuyOverviewCounts>[0]
    await getRealRentToBuyOverviewCounts(admin)
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'possession_status' && c.args[1] === 'return_required')).toBe(true)
  })

  it('10. a null count resolves to 0 for every field', async () => {
    const admin = { from: () => fakeCountQuery(null, []) } as unknown as Parameters<typeof getRealRentToBuyOverviewCounts>[0]
    const counts = await getRealRentToBuyOverviewCounts(admin)
    expect(Object.values(counts)).toEqual([0, 0, 0, 0, 0])
  })
})
