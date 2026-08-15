import { describe, it, expect, vi } from 'vitest'
import { getListings, getListing, getSimilarListings, getListingsByMerchant, getProfileReviews, excludeTestListings } from '../listings'
import { createClient as mockedCreateClient } from '@/lib/supabase/server'

/**
 * Regression coverage for the Clickable Customer Profiles privacy-
 * boundary corrective pass: `listings`/`reviews` queries must NEVER
 * embed `profiles` at all (not even FK-qualified) -- `profiles` is no
 * longer directly SELECT-able by anon/authenticated for another user's
 * row (supabase/migrations/20260831000001_profiles_privacy_boundary.sql
 * tightened its RLS to `auth.uid() = id`), and a PostgREST embed is
 * subject to the EMBEDDED table's own RLS as the querying role, so an
 * embed would silently return null for every listing's merchant/
 * review's reviewer. Merchant/reviewer identity is instead a separate
 * batched query against the `public_profiles` view. This supersedes
 * the older "FK-qualified embed" test suite from Unity SEO Pre-Launch
 * Hardening, which is no longer the correct architecture.
 */
function fakeSupabaseClient(fromCalls: string[], selectCalls: string[], rows: Record<string, unknown>[] = []) {
  const builder = {
    select(arg: string) {
      selectCalls.push(arg)
      return builder
    },
    eq() { return builder },
    neq() { return builder },
    in() { return builder },
    order() { return builder },
    limit() { return builder },
    range() { return builder },
    single() { return Promise.resolve({ data: rows[0] ?? null, error: null }) },
    maybeSingle() { return Promise.resolve({ data: rows[0] ?? null, error: null }) },
    then(resolve: (v: { data: unknown; count: number }) => void) { resolve({ data: rows, count: rows.length }) },
  }
  return {
    from(table: string) {
      fromCalls.push(table)
      return builder
    },
    rpc() {
      return Promise.resolve({ data: [], error: null })
    },
  }
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))

/** Minimal fake query-builder that only records .eq() calls — enough to prove the real filter is actually applied, without mocking the full Supabase client chain. */
function fakeQuery() {
  const calls: Array<[string, unknown]> = []
  const builder = {
    calls,
    eq(column: string, value: unknown) {
      calls.push([column, value])
      return builder
    },
  }
  return builder
}

describe('excludeTestListings — the one filter every real public listing query path applies (category: Test Fixture Isolation)', () => {
  it('applies is_test = false to the query', () => {
    const result = excludeTestListings(fakeQuery())
    expect(result.calls).toContainEqual(['is_test', false])
  })

  it('does not accidentally exclude on any other column', () => {
    const result = excludeTestListings(fakeQuery())
    expect(result.calls).toHaveLength(1)
    expect(result.calls[0][0]).toBe('is_test')
  })
})

describe('profiles privacy boundary (category: Listing Detail) — no query ever embeds profiles, qualified or bare', () => {
  it('1. getListing() never embeds profiles in its select string', async () => {
    const fromCalls: string[] = []
    const selectCalls: string[] = []
    vi.mocked(mockedCreateClient).mockResolvedValue(fakeSupabaseClient(fromCalls, selectCalls) as never)
    await getListing('11111111-1111-1111-1111-111111111111')
    expect(selectCalls.some((s) => s.includes('profiles'))).toBe(false)
  })

  it('2. getListings() never embeds profiles in its select string', async () => {
    const fromCalls: string[] = []
    const selectCalls: string[] = []
    vi.mocked(mockedCreateClient).mockResolvedValue(fakeSupabaseClient(fromCalls, selectCalls) as never)
    await getListings({})
    expect(selectCalls.some((s) => s.includes('profiles'))).toBe(false)
  })

  it('3. getSimilarListings() never embeds profiles in its select string', async () => {
    const fromCalls: string[] = []
    const selectCalls: string[] = []
    vi.mocked(mockedCreateClient).mockResolvedValue(fakeSupabaseClient(fromCalls, selectCalls) as never)
    await getSimilarListings({ id: 'x', category: 'tech' } as never)
    expect(selectCalls.some((s) => s.includes('profiles'))).toBe(false)
  })

  it('4. getListingsByMerchant() never embeds profiles in its select string', async () => {
    const fromCalls: string[] = []
    const selectCalls: string[] = []
    vi.mocked(mockedCreateClient).mockResolvedValue(fakeSupabaseClient(fromCalls, selectCalls) as never)
    await getListingsByMerchant('11111111-1111-1111-1111-111111111111')
    expect(selectCalls.some((s) => s.includes('profiles'))).toBe(false)
  })

  it('5. getListing() attaches merchant identity via a separate public_profiles query, keyed on the listing\'s merchant_id', async () => {
    const fromCalls: string[] = []
    const selectCalls: string[] = []
    const client = fakeSupabaseClient(fromCalls, selectCalls, [{ id: 'listing-1', merchant_id: 'merchant-1' }])
    vi.mocked(mockedCreateClient).mockResolvedValue(client as never)
    const result = await getListing('listing-1')
    expect(fromCalls).toContain('public_profiles')
    expect(result?.merchant_id).toBe('merchant-1')
  })
})

describe('getProfileReviews relationship handling (category: Listing Detail) — reviewer identity comes from a separate public_profiles lookup, never a reviews-table embed', () => {
  it('6. getProfileReviews() never embeds profiles in its select string', async () => {
    const fromCalls: string[] = []
    const selectCalls: string[] = []
    vi.mocked(mockedCreateClient).mockResolvedValue(fakeSupabaseClient(fromCalls, selectCalls) as never)
    await getProfileReviews('11111111-1111-1111-1111-111111111111')
    expect(selectCalls.some((s) => s.includes('profiles'))).toBe(false)
  })

  it('7. getProfileReviews() queries public_profiles for reviewer identity when reviews exist', async () => {
    const fromCalls: string[] = []
    const selectCalls: string[] = []
    const client = fakeSupabaseClient(fromCalls, selectCalls, [{ id: 'review-1', rating: 5, comment: 'x', created_at: '2026-01-01', reviewer_id: 'reviewer-1' }])
    vi.mocked(mockedCreateClient).mockResolvedValue(client as never)
    await getProfileReviews('22222222-2222-2222-2222-222222222222')
    expect(fromCalls).toContain('public_profiles')
  })

  it('8. getProfileReviews() still filters by reviewee_id -- no unrelated behavior change', async () => {
    const calls: Array<[string, unknown]> = []
    const builder = {
      select() { return builder },
      eq(column: string, value: unknown) { calls.push([column, value]); return builder },
      order() { return builder },
      then(resolve: (v: { data: unknown; count: number }) => void) { resolve({ data: [], count: 0 }) },
    }
    vi.mocked(mockedCreateClient).mockResolvedValue({ from: () => builder } as never)
    await getProfileReviews('22222222-2222-2222-2222-222222222222')
    expect(calls).toContainEqual(['reviewee_id', '22222222-2222-2222-2222-222222222222'])
  })
})

describe('getListings — country filtering is delegated to the search_listings RPC (category: Search Ranking)', () => {
  /** Captures the exact args search_listings was called with, and returns zero ranked rows so the function short-circuits before any further `.from()` calls. */
  function fakeClientCapturingRpcArgs(rpcCalls: Array<[string, unknown]>) {
    return {
      from() {
        return { select() { return this }, eq() { return this }, in() { return this } }
      },
      rpc(name: string, args: unknown) {
        rpcCalls.push([name, args])
        return Promise.resolve({ data: [], error: null })
      },
    }
  }

  it('passes countryId through to search_listings as p_country_id', async () => {
    const rpcCalls: Array<[string, unknown]> = []
    vi.mocked(mockedCreateClient).mockResolvedValue(fakeClientCapturingRpcArgs(rpcCalls) as never)
    await getListings({ countryId: 'ZA' })
    expect(rpcCalls).toHaveLength(1)
    expect(rpcCalls[0][0]).toBe('search_listings')
    expect((rpcCalls[0][1] as Record<string, unknown>).p_country_id).toBe('ZA')
  })

  it('omitting countryId passes null p_country_id (no country filtering)', async () => {
    const rpcCalls: Array<[string, unknown]> = []
    vi.mocked(mockedCreateClient).mockResolvedValue(fakeClientCapturingRpcArgs(rpcCalls) as never)
    await getListings({})
    expect((rpcCalls[0][1] as Record<string, unknown>).p_country_id).toBeNull()
  })

  it('a country with zero eligible rows resolves to an empty list, not an error', async () => {
    const rpcCalls: Array<[string, unknown]> = []
    vi.mocked(mockedCreateClient).mockResolvedValue(fakeClientCapturingRpcArgs(rpcCalls) as never)
    const filtered = await getListings({ countryId: 'NG' })
    expect(filtered).toEqual([])
  })
})
