import { describe, it, expect } from 'vitest'
import { spliceSponsoredListing, type SponsoredListingResult } from '../search-insertion'

interface FakeItem {
  id: string
  title: string
}

function organicPage(count: number): FakeItem[] {
  return Array.from({ length: count }, (_, i) => ({ id: `organic-${i}`, title: `Organic ${i}` }))
}

function slot(listingId = 'sponsored-1'): SponsoredListingResult {
  return { sponsored: true, campaignId: 'camp-1', listingId, impressionId: 'imp-1' }
}

describe('spliceSponsoredListing', () => {
  it('returns the organic items untouched when there is no sponsored slot', async () => {
    const organic = organicPage(10)
    const result = await spliceSponsoredListing(organic, null, async () => null)
    expect(result).toEqual(organic)
  })

  it('inserts the sponsored listing at the fixed presentation position, tagged sponsored', async () => {
    const organic = organicPage(10)
    const sponsoredItem: FakeItem = { id: 'sponsored-1', title: 'Sponsored Listing' }
    const result = await spliceSponsoredListing(organic, slot(), async (id) => (id === 'sponsored-1' ? sponsoredItem : null))

    expect(result).toHaveLength(11)
    expect(result[3]).toMatchObject({ id: 'sponsored-1', sponsored: true, adCampaignId: 'camp-1', adImpressionId: 'imp-1' })
    // Every organic item is preserved, unmutated, and none are tagged sponsored.
    for (const item of result) {
      if (item.id !== 'sponsored-1') expect(item).not.toHaveProperty('sponsored')
    }
  })

  it('never returns a sponsored slot when the organic page is too small to stay under the 60% density ceiling', async () => {
    // floor(2 * 0.6) = 1... but floor(1 * 0.6) = 0 -- a 1-item organic page must never carry an ad.
    const organic = organicPage(1)
    const sponsoredItem: FakeItem = { id: 'sponsored-1', title: 'Sponsored Listing' }
    const result = await spliceSponsoredListing(organic, slot(), async () => sponsoredItem)
    expect(result).toEqual(organic)
    expect(result).toHaveLength(1)
  })

  it('permanent 60% ceiling regression: for every organic page size, the ad-bearing result never exceeds 60% paid density', async () => {
    const sponsoredItem: FakeItem = { id: 'sponsored-1', title: 'Sponsored Listing' }
    for (let size = 0; size <= 20; size++) {
      const organic = organicPage(size)
      const result = await spliceSponsoredListing(organic, slot(), async () => sponsoredItem)
      const paidCount = result.filter((r) => 'sponsored' in r && r.sponsored).length
      if (result.length > 0) {
        expect(paidCount / result.length).toBeLessThanOrEqual(0.6)
      }
    }
  })

  it('drops the slot silently (falls back to pure organic) when the sponsored listing cannot be resolved -- never renders a broken card', async () => {
    const organic = organicPage(10)
    const result = await spliceSponsoredListing(organic, slot(), async () => null)
    expect(result).toEqual(organic)
  })

  it('inserts near the end of a page shorter than the fixed slot position, rather than throwing', async () => {
    const organic = organicPage(2)
    const sponsoredItem: FakeItem = { id: 'sponsored-1', title: 'Sponsored Listing' }
    const result = await spliceSponsoredListing(organic, slot(), async () => sponsoredItem)
    // floor(2 * 0.6) = 1, so a slot IS allowed; it clamps to the end of the array.
    expect(result).toHaveLength(3)
    expect(result[2]).toMatchObject({ id: 'sponsored-1', sponsored: true })
  })
})
