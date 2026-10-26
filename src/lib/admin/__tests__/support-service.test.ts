import { describe, it, expect, vi } from 'vitest'
import { listAdminSupportCases, getSupportCaseSummaryForUser, quotePostgrestFilterValue } from '../support-service'

const USER_ID = '11111111-1111-1111-1111-111111111111'

/** Records every chained call and resolves to `result` at the end, regardless of call order -- mirrors the pattern in users-service.test.ts. */
function chainableQuery(result: { data?: unknown; error?: unknown; count?: number | null }, spies: Record<string, ((...args: unknown[]) => unknown) | undefined>) {
  const obj: Record<string, unknown> = {
    select: (...args: unknown[]) => { spies.select?.(...args); return obj },
    order: (...args: unknown[]) => { spies.order?.(...args); return obj },
    range: (...args: unknown[]) => { spies.range?.(...args); return obj },
    eq: (...args: unknown[]) => { spies.eq?.(...args); return obj },
    or: (...args: unknown[]) => { spies.or?.(...args); return obj },
    is: (...args: unknown[]) => { spies.is?.(...args); return obj },
    not: (...args: unknown[]) => { spies.not?.(...args); return obj },
    in: (...args: unknown[]) => { spies.in?.(...args); return obj },
    limit: (...args: unknown[]) => { spies.limit?.(...args); return obj },
    then: (resolve: (v: typeof result) => void) => resolve(result),
  }
  return obj
}

/**
 * Splits a PostgREST combinator-list filter string (`col.op.val,col.op.val`)
 * into its top-level clauses, respecting double-quoted value segments --
 * i.e. a comma/paren inside `"..."` is NOT a clause separator. This is a
 * minimal stand-in for PostgREST's own parser, used here purely to prove
 * that a malicious search term embedded in a quoted value can never
 * appear to the real parser as an extra, injected top-level predicate.
 */
function splitTopLevelOrClauses(filterString: string): string[] {
  const clauses: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < filterString.length; i++) {
    const ch = filterString[i]
    if (ch === '"' && filterString[i - 1] !== '\\') inQuotes = !inQuotes
    if (ch === ',' && !inQuotes) {
      clauses.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  clauses.push(current)
  return clauses
}

describe('quotePostgrestFilterValue (category: ADMIN-CONTROL-CENTRE-BATCH-A2-NARROW-SEARCH-REMEDIATION) — PostgREST filter-value escaping', () => {
  it('1. wraps a plain value in double quotes, unchanged inside', () => {
    expect(quotePostgrestFilterValue('%John Smith%')).toBe('"%John Smith%"')
  })

  it('2. a literal double quote in the value is backslash-escaped so it cannot close the token early', () => {
    expect(quotePostgrestFilterValue('%"quoted"%')).toBe('"%\\"quoted\\"%"')
  })

  it('3. a literal backslash is itself escaped first, so it cannot be used to unescape a following quote', () => {
    expect(quotePostgrestFilterValue('%back\\slash%')).toBe('"%back\\\\slash%"')
  })

  it('4. hyphens, commas, parens, periods, and colons all pass through literally inside the quotes', () => {
    expect(quotePostgrestFilterValue('%SUP-2026-000001%')).toBe('"%SUP-2026-000001%"')
    expect(quotePostgrestFilterValue('%abc,(def):ghi.test%')).toBe('"%abc,(def):ghi.test%"')
  })
})

describe('listAdminSupportCases search (category: ADMIN-CONTROL-CENTRE-BATCH-A2-NARROW-SEARCH-REMEDIATION) — adversarial search-term handling', () => {
  const ADVERSARIAL_INPUTS = [
    'abc,def',
    'abc(def)',
    'abc.def',
    'abc:def',
    'abc,(def):ghi.test',
    'abc%def',
    'abc_def',
    "O'Brien",
    '"quoted"',
    'back\\slash',
    'SUP-2026-000001',
    'John Smith',
  ]

  it.each(ADVERSARIAL_INPUTS)('1. %s never produces more than the 2 (or 4) real clauses -- no injected predicate', async (input) => {
    const orCalls: string[] = []
    const admin = {
      from: (table: string) => {
        if (table === 'profiles') return chainableQuery({ data: [], error: null }, {})
        return chainableQuery({ data: [], error: null, count: 0 }, { or: (clause: unknown) => orCalls.push(clause as string) })
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    await listAdminSupportCases(admin, { search: input })

    // No matching profiles in this test, so exactly 2 real clauses:
    // case_number.ilike and title.ilike -- regardless of what punctuation
    // the search term itself contains.
    const supportCasesOrCall = orCalls.find((c) => c.includes('case_number'))
    expect(supportCasesOrCall).toBeDefined()
    const clauses = splitTopLevelOrClauses(supportCasesOrCall as string)
    expect(clauses).toHaveLength(2)
    expect(clauses[0]).toMatch(/^case_number\.ilike\./)
    expect(clauses[1]).toMatch(/^title\.ilike\./)
  })

  it('2. a search term with a matching profile still yields exactly 4 real clauses, never a 5th injected one', async () => {
    const orCalls: string[] = []
    const admin = {
      from: (table: string) => {
        if (table === 'profiles') return chainableQuery({ data: [{ id: USER_ID }], error: null }, {})
        return chainableQuery({ data: [], error: null, count: 0 }, { or: (clause: unknown) => orCalls.push(clause as string) })
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    await listAdminSupportCases(admin, { search: 'abc,(def):ghi.test' })
    const supportCasesOrCall = orCalls.find((c) => c.includes('case_number')) as string
    const clauses = splitTopLevelOrClauses(supportCasesOrCall)
    expect(clauses).toHaveLength(4)
    expect(clauses[2]).toBe(`customer_id.in.(${USER_ID})`)
    expect(clauses[3]).toBe(`merchant_id.in.(${USER_ID})`)
  })

  it('3. case-number search is preserved -- the hyphenated value survives quoting intact', async () => {
    const orCalls: string[] = []
    const admin = {
      from: (table: string) => {
        if (table === 'profiles') return chainableQuery({ data: [], error: null }, {})
        return chainableQuery({ data: [], error: null, count: 0 }, { or: (clause: unknown) => orCalls.push(clause as string) })
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    await listAdminSupportCases(admin, { search: 'SUP-2026-000001' })
    const clause = orCalls.find((c) => c.includes('case_number')) as string
    expect(clause).toContain('case_number.ilike."%SUP-2026-000001%"')
  })

  it('4. normal name search ("John Smith") still reaches the profiles lookup with a valid, space-preserving quoted value', async () => {
    const profilesOrSpy = vi.fn()
    const admin = {
      from: (table: string) => {
        if (table === 'profiles') return chainableQuery({ data: [], error: null }, { or: profilesOrSpy })
        return chainableQuery({ data: [], error: null, count: 0 }, {})
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    await listAdminSupportCases(admin, { search: 'John Smith' })
    expect(profilesOrSpy).toHaveBeenCalledWith('full_name.ilike."%John Smith%",display_name.ilike."%John Smith%"')
  })

  it('5. search remains server-side (pushed via .or/.in), never fetched in full and filtered client-side -- same guarantee as before this fix', async () => {
    let supportCasesFromCalled = false
    const admin = {
      from: (table: string) => {
        if (table === 'profiles') return chainableQuery({ data: [], error: null }, {})
        supportCasesFromCalled = true
        return chainableQuery({ data: [], error: null, count: 0 }, {})
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    const page = await listAdminSupportCases(admin, { search: 'abc,(def)', offset: 10, limit: 5 })
    expect(supportCasesFromCalled).toBe(true)
    expect(page.cases).toEqual([])
  })

  it('6. malformed-looking input (unbalanced quote/parens) does not throw -- it is quoted as a single literal value, not parsed as a mini-grammar', async () => {
    const admin = {
      from: () => chainableQuery({ data: [], error: null, count: 0 }, {}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    await expect(listAdminSupportCases(admin, { search: '"unbalanced(((' })).resolves.toBeDefined()
  })
})

describe('listAdminSupportCases (category: ADMIN-CONTROL-CENTRE-BATCH-A2) — list filters + pagination (J)', () => {
  it('1. status/priority/category filters are pushed to Postgres via .eq, never applied in memory', async () => {
    const eqSpy = vi.fn()
    const admin = {
      from: () => chainableQuery({ data: [], error: null, count: 0 }, { eq: eqSpy }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    await listAdminSupportCases(admin, { status: 'open', priority: 'high', category: 'payment' })
    expect(eqSpy).toHaveBeenCalledWith('status', 'open')
    expect(eqSpy).toHaveBeenCalledWith('priority', 'high')
    expect(eqSpy).toHaveBeenCalledWith('category', 'payment')
  })

  it('2. unassigned=true filters via .is(assigned_admin_id, null), not an .eq on a literal admin id', async () => {
    const isSpy = vi.fn()
    const eqSpy = vi.fn()
    const admin = {
      from: () => chainableQuery({ data: [], error: null, count: 0 }, { is: isSpy, eq: eqSpy }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    await listAdminSupportCases(admin, { unassigned: true, assignedAdminId: USER_ID })
    expect(isSpy).toHaveBeenCalledWith('assigned_admin_id', null)
    expect(eqSpy).not.toHaveBeenCalledWith('assigned_admin_id', USER_ID)
  })

  it('3. the range (offset/limit) is always pushed to Postgres, never fetched in full and sliced client-side', async () => {
    const rangeSpy = vi.fn()
    const admin = {
      from: () => chainableQuery({ data: [], error: null, count: 0 }, { range: rangeSpy }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    await listAdminSupportCases(admin, { offset: 50, limit: 25 })
    expect(rangeSpy).toHaveBeenCalledWith(50, 74)
  })

  it('4. the Customer/Merchant 360 participant filter matches either role via .or', async () => {
    const orSpy = vi.fn()
    const admin = {
      from: () => chainableQuery({ data: [], error: null, count: 0 }, { or: orSpy }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    await listAdminSupportCases(admin, { participantUserId: USER_ID })
    expect(orSpy).toHaveBeenCalledWith(`customer_id.eq.${USER_ID},merchant_id.eq.${USER_ID}`)
  })

  it('5. a search term resolves matching profile ids first, then combines case_number/title/customer/merchant into one server-side .or clause', async () => {
    const orSpy = vi.fn()
    let fromCallCount = 0
    const admin = {
      from: (table: string) => {
        fromCallCount += 1
        if (table === 'profiles') {
          return chainableQuery({ data: [{ id: USER_ID }], error: null }, {})
        }
        return chainableQuery({ data: [], error: null, count: 0 }, { or: orSpy })
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    await listAdminSupportCases(admin, { search: 'Jane' })
    expect(fromCallCount).toBeGreaterThanOrEqual(2)
    const clause = orSpy.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('case_number'))?.[0] as string
    expect(clause).toContain('case_number.ilike')
    expect(clause).toContain('title.ilike')
    expect(clause).toContain(`customer_id.in.(${USER_ID})`)
  })

  it('6. an empty result page still returns total from the count, not 0-by-assumption', async () => {
    const admin = {
      from: () => chainableQuery({ data: [], error: null, count: 7 }, {}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    const page = await listAdminSupportCases(admin, {})
    expect(page.total).toBe(7)
    expect(page.cases).toEqual([])
  })
})

describe('getSupportCaseSummaryForUser (category: ADMIN-CONTROL-CENTRE-BATCH-A2) — Customer/Merchant 360 integration (F, G) + privacy (H)', () => {
  it('1. counts and recent cases both match either customer_id or merchant_id for this profile', async () => {
    const orSpies: string[] = []
    const admin = {
      from: () => chainableQuery({ data: [], error: null, count: 2 }, { or: (clause: unknown) => orSpies.push(clause as string) }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    const summary = await getSupportCaseSummaryForUser(admin, USER_ID)
    expect(summary.openCount).toBe(2)
    expect(orSpies.every((c) => c === `customer_id.eq.${USER_ID},merchant_id.eq.${USER_ID}`)).toBe(true)
  })

  it('2. the open count excludes resolved/closed cases via a server-side .not filter, never counted then filtered client-side', async () => {
    const notSpy = vi.fn()
    const admin = {
      from: () => chainableQuery({ data: [], error: null, count: 0 }, { not: notSpy, or: () => undefined }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    await getSupportCaseSummaryForUser(admin, USER_ID)
    expect(notSpy).toHaveBeenCalledWith('status', 'in', '(resolved,closed)')
  })

  it('3. this function never touches the Admin Auth API -- it only reads the support_cases table, so an erased account can never regain auth PII through this path (mirrors the A1 P1 fix\'s guarantee)', async () => {
    const admin = {
      from: (table: string) => {
        expect(table).toBe('support_cases')
        return chainableQuery({ data: [], error: null, count: 0 }, {})
      },
      auth: { admin: { getUserById: vi.fn(() => { throw new Error('should never be called') }) } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    await getSupportCaseSummaryForUser(admin, USER_ID)
    expect(admin.auth.admin.getUserById).not.toHaveBeenCalled()
  })
})
