import { getListings } from '@/lib/data/listings'
import { CATEGORIES } from '@/types'
import type { Listing } from '@/types'

export interface CategorySection {
  category: (typeof CATEGORIES)[number]
  listings: Listing[]
}

/**
 * Real, per-category rows for the magazine-style Browse/Homepage layout
 * (E47 Phases I/K) -- one real `getListings` query per category, never a
 * single flat query re-sliced client-side (that would silently misrepresent
 * which items are actually "in" each category). Categories with zero
 * matching live listings are omitted entirely rather than rendered empty,
 * so the page never shows a hollow "TECH" section with no cards under it.
 */
export async function getCategorySections(
  countryId: string,
  { limitPerCategory = 8, maxSections = 6 }: { limitPerCategory?: number; maxSections?: number } = {}
): Promise<CategorySection[]> {
  const perCategory = await Promise.all(
    CATEGORIES.map(async (category) => {
      const listings = await getListings({ mode: 'rent', category: category.id, countryId, sort: 'newest' })
      return { category, listings: listings.slice(0, limitPerCategory) }
    })
  )

  return perCategory.filter((section) => section.listings.length > 0).slice(0, maxSections)
}
