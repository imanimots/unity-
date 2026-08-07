import { describe, it, expect, vi } from 'vitest'
import { getListings, getListing, getSimilarListings, getListingsByMerchant, getProfileReviews, excludeTestListings } from '../listings'
import { createClient as mockedCreateClient } from '@/lib/supabase/server'

/**
 * Regression coverage for the pre-existing listing-detail 404 bug found
 * during Unity SEO Pre-Launch Hardening: `listings` gained two more FKs
 * to `profiles` (`affiliate_enabled_by`, `affiliate_rate_updated_by`,
 * added by the Phase 7 affiliate migration), which makes a bare
 * `profiles(*)` embed ambiguous to PostgREST (error PGRST201) --
 * silently breaking every function in this file that joins to the
 * merchant profile. The fix is to always qualify the embed with the
 * exact FK constraint name (`profiles!listings_merchant_id_fkey`).
 * This test proves every real-Supabase-path query in listings.ts still
 * uses the qualified form, without needing a live database -- it mocks
 * '@/lib/supabase/server' directly since these functions dynamically
 * import it.
 */
function fakeSupabaseClient(selectCalls: string[]) {
  const builder = {
    select(arg: string) {
      selectCalls.push(arg)
      return builder
    },
    eq() { return builder },
    neq() { return builder },
    order() { return builder },
    limit() { return builder },
    single() { return Promise.resolve({ data: null, error: null }) },
    maybeSingle() { return Promise.resolve({ data: null, error: null }) },
    then(resolve: (v: { data: unknown }) => void) { resolve({ data: [] }) },
  }
  return {
    from() { return builder },
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

describe('listing-detail 404 regression (category: Listing Detail) — every query embeds profiles through the exact FK, never the ambiguous bare form', () => {
  it('1. getListing() qualifies the merchant embed with listings_merchant_id_fkey', async () => {
    const selectCalls: string[] = []
    vi.mocked(mockedCreateClient).mockResolvedValue(fakeSupabaseClient(selectCalls) as never)
    await getListing('11111111-1111-1111-1111-111111111111')
    expect(selectCalls.some((s) => s.includes('profiles!listings_merchant_id_fkey'))).toBe(true)
    expect(selectCalls.some((s) => /[^!]profiles\(/.test(s))).toBe(false)
  })

  it('2. getListings() qualifies the merchant embed with listings_merchant_id_fkey', async () => {
    const selectCalls: string[] = []
    vi.mocked(mockedCreateClient).mockResolvedValue(fakeSupabaseClient(selectCalls) as never)
    await getListings({})
    expect(selectCalls.some((s) => s.includes('profiles!listings_merchant_id_fkey'))).toBe(true)
  })

  it('3. getSimilarListings() qualifies the merchant embed with listings_merchant_id_fkey', async () => {
    const selectCalls: string[] = []
    vi.mocked(mockedCreateClient).mockResolvedValue(fakeSupabaseClient(selectCalls) as never)
    await getSimilarListings({ id: 'x', category: 'tech' } as never)
    expect(selectCalls.some((s) => s.includes('profiles!listings_merchant_id_fkey'))).toBe(true)
  })

  it('4. getListingsByMerchant() qualifies the merchant embed with listings_merchant_id_fkey', async () => {
    const selectCalls: string[] = []
    vi.mocked(mockedCreateClient).mockResolvedValue(fakeSupabaseClient(selectCalls) as never)
    await getListingsByMerchant('11111111-1111-1111-1111-111111111111')
    expect(selectCalls.some((s) => s.includes('profiles!listings_merchant_id_fkey'))).toBe(true)
  })
})

describe('getProfileReviews relationship ambiguity fix (category: Listing Detail) — reviews has two FKs to profiles (reviewer_id, reviewee_id), so the reviewer embed must be FK-qualified', () => {
  it('5. getProfileReviews() qualifies the reviewer embed with reviews_reviewer_id_fkey, never the ambiguous bare form', async () => {
    const selectCalls: string[] = []
    vi.mocked(mockedCreateClient).mockResolvedValue(fakeSupabaseClient(selectCalls) as never)
    await getProfileReviews('11111111-1111-1111-1111-111111111111')
    expect(selectCalls.some((s) => s.includes('profiles!reviews_reviewer_id_fkey'))).toBe(true)
    expect(selectCalls.some((s) => /[^!]profiles\(/.test(s))).toBe(false)
  })

  it('6. getProfileReviews() still filters by reviewee_id -- no unrelated behavior change', async () => {
    const calls: Array<[string, unknown]> = []
    const builder = {
      select() { return builder },
      eq(column: string, value: unknown) { calls.push([column, value]); return builder },
      order() { return builder },
      then(resolve: (v: { data: unknown }) => void) { resolve({ data: [] }) },
    }
    vi.mocked(mockedCreateClient).mockResolvedValue({ from: () => builder } as never)
    await getProfileReviews('22222222-2222-2222-2222-222222222222')
    expect(calls).toContainEqual(['reviewee_id', '22222222-2222-2222-2222-222222222222'])
  })
})

describe('getListings — country filtering (mock-mode path)', () => {
  it('returns results when filtered by the country every mock listing actually has', async () => {
    const all = await getListings({})
    const filtered = await getListings({ countryId: 'ZA' })
    expect(filtered.length).toBe(all.length)
    expect(filtered.every((l) => l.country_id === 'ZA')).toBe(true)
  })

  it('returns nothing for a country no mock listing belongs to', async () => {
    const filtered = await getListings({ countryId: 'NG' })
    expect(filtered).toEqual([])
  })

  it('omitting countryId does not filter by country at all', async () => {
    const withFilter = await getListings({ countryId: 'ZA' })
    const withoutFilter = await getListings({})
    expect(withoutFilter.length).toBe(withFilter.length)
  })
})
