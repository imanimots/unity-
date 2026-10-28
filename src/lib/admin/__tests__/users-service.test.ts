import { describe, it, expect } from 'vitest'
import { listAdminUsers, getRealUserOverviewCounts, getAdminUserDetail } from '../users-service'

interface RecordedCall {
  method: string
  args: unknown[]
}

/**
 * D3-C rewrite: the prior mock only spied on the FIRST `.eq()`/`.or()`
 * call immediately after `.limit()`, which broke the moment real-data
 * scoping inserted its own `.eq('data_classification', ...)` ahead of
 * the search/filter calls it used to assert on directly. This version
 * records every chained call (in order) onto a shared array instead,
 * so assertions can find the specific call they care about regardless
 * of how many other filters now sit around it.
 */
function fakeProfilesQuery(result: { data?: unknown; count?: number | null; error?: unknown }, calls: RecordedCall[]) {
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

const UUID = '11111111-1111-1111-1111-111111111111'

describe('users-service: listAdminUsers search targets (category: ADMIN-CONTROL-CENTRE-BATCH-A1)', () => {
  it('1. a UUID-shaped search term does an exact id match, not a name/phone substring search', async () => {
    const calls: RecordedCall[] = []
    const admin = { from: () => fakeProfilesQuery({ data: [], error: null }, calls) } as unknown as Parameters<typeof listAdminUsers>[0]
    await listAdminUsers(admin, { search: UUID })
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'id' && c.args[1] === UUID)).toBe(true)
    expect(calls.some((c) => c.method === 'or')).toBe(false)
  })

  it('2. a non-UUID search term searches name and phone -- never email (profiles has no email column)', async () => {
    const calls: RecordedCall[] = []
    const admin = { from: () => fakeProfilesQuery({ data: [], error: null }, calls) } as unknown as Parameters<typeof listAdminUsers>[0]
    await listAdminUsers(admin, { search: '082' })
    const orCalls = calls.filter((c) => c.method === 'or')
    expect(orCalls).toHaveLength(1)
    const clause = orCalls[0].args[0] as string
    expect(clause).toContain('full_name.ilike')
    expect(clause).toContain('display_name.ilike')
    expect(clause).toContain('phone.ilike')
    expect(clause).not.toContain('email')
  })
})

describe('users-service: D3-C real-data scope adoption (category: ADMIN-CONTROL-CENTRE-BATCH-D3-C)', () => {
  it('3. listAdminUsers filters on data_classification = \'real\' -- positive equality, never a negative/<> comparison', () => {
    const calls: RecordedCall[] = []
    const admin = { from: () => fakeProfilesQuery({ data: [], error: null }, calls) } as unknown as Parameters<typeof listAdminUsers>[0]
    return listAdminUsers(admin, {}).then(() => {
      expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'data_classification' && c.args[1] === 'real')).toBe(true)
    })
  })

  it('4. the real-data filter composes with an existing status filter, not replaces it', async () => {
    const calls: RecordedCall[] = []
    const admin = { from: () => fakeProfilesQuery({ data: [], error: null }, calls) } as unknown as Parameters<typeof listAdminUsers>[0]
    await listAdminUsers(admin, { accountStatus: 'active' })
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'data_classification' && c.args[1] === 'real')).toBe(true)
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'account_status' && c.args[1] === 'active')).toBe(true)
  })

  it('5. the real-data filter is applied even for a search query -- scope composes with search, not fetch-then-filter', async () => {
    const calls: RecordedCall[] = []
    const admin = { from: () => fakeProfilesQuery({ data: [], error: null }, calls) } as unknown as Parameters<typeof listAdminUsers>[0]
    await listAdminUsers(admin, { search: 'Jane' })
    const scopeIdx = calls.findIndex((c) => c.method === 'eq' && c.args[0] === 'data_classification')
    const orIdx = calls.findIndex((c) => c.method === 'or')
    expect(scopeIdx).toBeGreaterThanOrEqual(0)
    expect(orIdx).toBeGreaterThanOrEqual(0)
  })
})

describe('users-service: getRealUserOverviewCounts (category: ADMIN-CONTROL-CENTRE-BATCH-D3-C)', () => {
  it('6. every count query is scoped to data_classification = \'real\'', async () => {
    const calls: RecordedCall[] = []
    const admin = {
      from: () => fakeProfilesQuery({ count: 7, data: null, error: null }, calls),
    } as unknown as Parameters<typeof getRealUserOverviewCounts>[0]
    const counts = await getRealUserOverviewCounts(admin)
    expect(counts.totalUsers).toBe(7)
    expect(counts.activeUsers).toBe(7)
    expect(counts.merchants).toBe(7)
    expect(counts.renters).toBe(7)
    expect(counts.suspendedUsers).toBe(7)
    expect(counts.restrictedUsers).toBe(7)
    const scopeCalls = calls.filter((c) => c.method === 'eq' && c.args[0] === 'data_classification' && c.args[1] === 'real')
    // One scoped query per returned metric.
    expect(scopeCalls.length).toBe(6)
  })

  it('7. a null count (no rows) resolves to 0, never undefined/NaN', async () => {
    const admin = {
      from: () => fakeProfilesQuery({ count: null, data: null, error: null }, []),
    } as unknown as Parameters<typeof getRealUserOverviewCounts>[0]
    const counts = await getRealUserOverviewCounts(admin)
    expect(counts.totalUsers).toBe(0)
    expect(counts.suspendedUsers).toBe(0)
  })
})

/**
 * A universal query stub for getAdminUserDetail's fan-out: every table
 * other than `profiles` just needs to resolve to an empty/zero result
 * without throwing, so these tests can isolate the one behavior under
 * test -- the real-data scope check immediately after the profile
 * fetch -- without hand-mocking all 10+ sub-queries it fans out to.
 */
function fakeUserDetailAdmin(profileRow: Record<string, unknown> | null) {
  const empty: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'or', 'order', 'limit', 'in', 'not']) {
    empty[method] = () => empty
  }
  empty.then = (resolve: (v: { data: unknown[]; count: number; error: null }) => void) =>
    resolve({ data: [], count: 0, error: null })
  empty.maybeSingle = () => ({
    then: (resolve: (v: { data: null; error: null }) => void) => resolve({ data: null, error: null }),
  })

  const profileQuery: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'or', 'order', 'limit', 'in', 'not']) {
    profileQuery[method] = () => profileQuery
  }
  profileQuery.maybeSingle = () => ({
    then: (resolve: (v: { data: Record<string, unknown> | null; error: null }) => void) =>
      resolve({ data: profileRow, error: null }),
  })

  return {
    from: (table: string) => (table === 'profiles' ? profileQuery : empty),
  } as unknown as Parameters<typeof getAdminUserDetail>[0]
}

describe('users-service: getAdminUserDetail real-data scope (category: ADMIN-CONTROL-CENTRE-BATCH-D3-C)', () => {
  const baseProfile = {
    id: 'u1', full_name: 'Real User', display_name: null, phone: null, role: 'renter',
    kyc_status: 'approved', account_status: 'active', status_reason: null, status_changed_at: null,
    unity_score: 4.0, created_at: '2026-01-01T00:00:00Z',
  }

  it('8. a confirmed-real profile is returned normally', async () => {
    const admin = fakeUserDetailAdmin({ ...baseProfile, data_classification: 'real' })
    const detail = await getAdminUserDetail(admin, 'u1')
    expect(detail).not.toBeNull()
    expect(detail?.profile.id).toBe('u1')
  })

  it('9. a known test-classified profile id cannot bypass Real Data scope via direct lookup -- treated as not found', async () => {
    const admin = fakeUserDetailAdmin({ ...baseProfile, data_classification: 'test' })
    const detail = await getAdminUserDetail(admin, 'u1')
    expect(detail).toBeNull()
  })

  it('10. a known unknown-classified profile id cannot bypass Real Data scope via direct lookup -- treated as not found', async () => {
    const admin = fakeUserDetailAdmin({ ...baseProfile, data_classification: 'unknown' })
    const detail = await getAdminUserDetail(admin, 'u1')
    expect(detail).toBeNull()
  })

  it('11. a profile row that omits data_classification entirely is treated as unknown, never real -- fail-safe, not fail-open', async () => {
    const admin = fakeUserDetailAdmin({ ...baseProfile })
    const detail = await getAdminUserDetail(admin, 'u1')
    expect(detail).toBeNull()
  })
})
