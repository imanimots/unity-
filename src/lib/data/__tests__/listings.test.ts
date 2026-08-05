import { describe, it, expect } from 'vitest'
import { getListings } from '../listings'

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
