import type { Listing } from '@/types'
import {
  MOCK_LISTINGS,
  MOCK_REVIEWS,
  IS_MOCK_MODE,
} from '@/lib/mock/data'

export interface ListingFilters {
  category?: string
  query?: string
  minPrice?: number
  maxPrice?: number
  location?: string
  sort?: 'relevance' | 'price_asc' | 'price_desc' | 'newest' | 'rating'
}

export async function getListings(filters: ListingFilters = {}): Promise<Listing[]> {
  if (IS_MOCK_MODE) {
    let results = [...MOCK_LISTINGS]

    if (filters.category) {
      results = results.filter((l) => l.category === filters.category)
    }
    if (filters.query) {
      const q = filters.query.toLowerCase()
      results = results.filter(
        (l) =>
          l.title.toLowerCase().includes(q) ||
          l.description?.toLowerCase().includes(q) ||
          l.category.toLowerCase().includes(q)
      )
    }
    if (filters.minPrice !== undefined) {
      results = results.filter((l) => l.daily_rate >= filters.minPrice!)
    }
    if (filters.maxPrice !== undefined) {
      results = results.filter((l) => l.daily_rate <= filters.maxPrice!)
    }

    switch (filters.sort) {
      case 'price_asc':
        results.sort((a, b) => a.daily_rate - b.daily_rate)
        break
      case 'price_desc':
        results.sort((a, b) => b.daily_rate - a.daily_rate)
        break
      case 'newest':
        results.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        break
      case 'rating':
        results.sort((a, b) => (b.merchant?.unity_score ?? 0) - (a.merchant?.unity_score ?? 0))
        break
    }

    return results
  }

  // Real Supabase path (used when env vars are set)
  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  if (!supabase) return []

  let query = supabase
    .from('listings')
    .select('*, merchant:profiles(*), media:listing_media(*)')
    .eq('status', 'active')

  if (filters.category) query = query.eq('category', filters.category)
  if (filters.query) query = query.ilike('title', `%${filters.query}%`)
  if (filters.minPrice !== undefined) query = query.gte('daily_rate', filters.minPrice)
  if (filters.maxPrice !== undefined) query = query.lte('daily_rate', filters.maxPrice)

  const { data } = await query
  return data ?? []
}

export async function getListing(id: string): Promise<Listing | null> {
  if (IS_MOCK_MODE) {
    return MOCK_LISTINGS.find((l) => l.id === id) ?? null
  }

  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  if (!supabase) return null

  const { data } = await supabase
    .from('listings')
    .select('*, merchant:profiles(*), media:listing_media(*)')
    .eq('id', id)
    .single()

  return data
}

export async function getSimilarListings(listing: Listing, limit = 4): Promise<Listing[]> {
  if (IS_MOCK_MODE) {
    return MOCK_LISTINGS.filter(
      (l) => l.id !== listing.id && l.category === listing.category
    ).slice(0, limit)
  }

  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  if (!supabase) return []

  const { data } = await supabase
    .from('listings')
    .select('*, merchant:profiles(*), media:listing_media(*)')
    .eq('status', 'active')
    .eq('category', listing.category)
    .neq('id', listing.id)
    .limit(limit)

  return data ?? []
}

export function getListingReviews(listingId: string) {
  if (IS_MOCK_MODE) {
    const listing = MOCK_LISTINGS.find((l) => l.id === listingId)
    if (!listing) return []
    return MOCK_REVIEWS.filter((r) => r.reviewee_id === listing.merchant_id)
  }
  return []
}

export function getAverageRating(reviews: { rating: number }[]): number {
  if (!reviews.length) return 0
  return reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length
}
