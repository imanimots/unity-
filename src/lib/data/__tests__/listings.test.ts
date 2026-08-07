import { describe, it, expect } from 'vitest'
import { getListings, excludeTestListings } from '../listings'

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
