import { describe, it, expect } from 'vitest'
import { listAdminBarterAgreements, getAdminBarterDetail, getRealBarterOverviewCounts } from '../barter-service'

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

describe('barter-service: listAdminBarterAgreements real-data scope (category: ADMIN-CONTROL-CENTRE-BATCH-D3-D)', () => {
  it('1. filters both party_a and party_b embedded profile data_classification = \'real\' -- no own is_test column on this table', async () => {
    const calls: RecordedCall[] = []
    const admin = { from: () => fakeListQuery(calls) } as unknown as Parameters<typeof listAdminBarterAgreements>[0]
    await listAdminBarterAgreements(admin, {})
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'party_a_profile.data_classification' && c.args[1] === 'real')).toBe(true)
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'party_b_profile.data_classification' && c.args[1] === 'real')).toBe(true)
  })

  it('2. the real-data filter composes with an existing status filter', async () => {
    const calls: RecordedCall[] = []
    const admin = { from: () => fakeListQuery(calls) } as unknown as Parameters<typeof listAdminBarterAgreements>[0]
    await listAdminBarterAgreements(admin, { status: 'proposed' })
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'party_a_profile.data_classification')).toBe(true)
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'status' && c.args[1] === 'proposed')).toBe(true)
  })

  it('3. zero real agreements returns an empty array without throwing', async () => {
    const admin = { from: () => fakeListQuery([]) } as unknown as Parameters<typeof listAdminBarterAgreements>[0]
    const rows = await listAdminBarterAgreements(admin, {})
    expect(rows).toEqual([])
  })
})

function fakeBarterDetailAdmin(agreement: Record<string, unknown> | null, profileRows: Record<string, unknown>[]) {
  const agreementQuery: Record<string, unknown> = {}
  for (const method of ['select', 'eq']) agreementQuery[method] = () => agreementQuery
  agreementQuery.maybeSingle = () => Promise.resolve({ data: agreement, error: null })

  const profilesQuery: Record<string, unknown> = {}
  for (const method of ['select', 'in']) profilesQuery[method] = () => profilesQuery
  profilesQuery.then = (resolve: (v: { data: typeof profileRows; error: null }) => void) => resolve({ data: profileRows, error: null })

  const empty: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'order']) empty[method] = () => empty
  empty.then = (resolve: (v: { data: unknown[]; error: null }) => void) => resolve({ data: [], error: null })

  return {
    from: (table: string) => {
      if (table === 'barter_agreements') return agreementQuery
      if (table === 'profiles') return profilesQuery
      return empty
    },
  } as unknown as Parameters<typeof getAdminBarterDetail>[0]
}

describe('barter-service: getAdminBarterDetail real-data scope (category: ADMIN-CONTROL-CENTRE-BATCH-D3-D)', () => {
  const baseAgreement = { id: 'ba1', party_a_id: 'a1', party_b_id: 'b1', anchor_listing_id: null, source_skill_task_post_id: null }

  it('4. both parties real resolves normally', async () => {
    const admin = fakeBarterDetailAdmin(baseAgreement, [
      { id: 'a1', data_classification: 'real' },
      { id: 'b1', data_classification: 'real' },
    ])
    const detail = await getAdminBarterDetail(admin, 'ba1')
    expect(detail).not.toBeNull()
  })

  it('5. a test-classified party_b blocks the agreement even though party_a is real', async () => {
    const admin = fakeBarterDetailAdmin(baseAgreement, [
      { id: 'a1', data_classification: 'real' },
      { id: 'b1', data_classification: 'test' },
    ])
    const detail = await getAdminBarterDetail(admin, 'ba1')
    expect(detail).toBeNull()
  })

  it('6. an unknown-classified party_a blocks the agreement', async () => {
    const admin = fakeBarterDetailAdmin(baseAgreement, [
      { id: 'a1', data_classification: 'unknown' },
      { id: 'b1', data_classification: 'real' },
    ])
    const detail = await getAdminBarterDetail(admin, 'ba1')
    expect(detail).toBeNull()
  })

  it('7. a missing party profile row (never resolved) is treated as unknown, never real', async () => {
    const admin = fakeBarterDetailAdmin(baseAgreement, [{ id: 'a1', data_classification: 'real' }])
    const detail = await getAdminBarterDetail(admin, 'ba1')
    expect(detail).toBeNull()
  })

  it('8. a missing agreement row returns null', async () => {
    const admin = fakeBarterDetailAdmin(null, [])
    const detail = await getAdminBarterDetail(admin, 'missing')
    expect(detail).toBeNull()
  })
})

function fakeCountQuery(count: number | null, calls: RecordedCall[]) {
  const obj: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'in']) {
    obj[method] = (...args: unknown[]) => {
      calls.push({ method, args })
      return obj
    }
  }
  obj.then = (resolve: (v: { count: number | null; error: null }) => void) => resolve({ count, error: null })
  return obj
}

describe('barter-service: getRealBarterOverviewCounts (category: ADMIN-CONTROL-CENTRE-BATCH-D3-D-F1)', () => {
  it('9. every count filters both party_a and party_b embedded profile data_classification=\'real\'', async () => {
    const calls: RecordedCall[] = []
    const admin = { from: () => fakeCountQuery(1, calls) } as unknown as Parameters<typeof getRealBarterOverviewCounts>[0]
    await getRealBarterOverviewCounts(admin)
    const partyACalls = calls.filter((c) => c.method === 'eq' && c.args[0] === 'party_a_profile.data_classification' && c.args[1] === 'real')
    const partyBCalls = calls.filter((c) => c.method === 'eq' && c.args[0] === 'party_b_profile.data_classification' && c.args[1] === 'real')
    expect(partyACalls.length).toBe(5)
    expect(partyBCalls.length).toBe(5)
  })

  it('10. admin_held_barter_agreements filters admin_hold=true specifically', async () => {
    const calls: RecordedCall[] = []
    const admin = { from: () => fakeCountQuery(1, calls) } as unknown as Parameters<typeof getRealBarterOverviewCounts>[0]
    await getRealBarterOverviewCounts(admin)
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'admin_hold' && c.args[1] === true)).toBe(true)
  })

  it('11. a null count resolves to 0 for every field', async () => {
    const admin = { from: () => fakeCountQuery(null, []) } as unknown as Parameters<typeof getRealBarterOverviewCounts>[0]
    const counts = await getRealBarterOverviewCounts(admin)
    expect(Object.values(counts)).toEqual([0, 0, 0, 0, 0])
  })
})
