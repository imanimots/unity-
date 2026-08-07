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
  /** Maps the browse-page Buy/Rent toggle to listing_type. 'rent' -> rental|both, 'buy' -> sale|both. Omit for no type filtering. */
  mode?: 'buy' | 'rent'
  /**
   * Scopes results to one country (public browse/search only — see
   * resolveEffectiveCountry()). Omit to skip country filtering entirely —
   * used deliberately by getListingsByMerchant() and any internal/admin
   * lookup, which must never lose a row just because the browsing
   * country changed.
   */
  countryId?: string
}

/** Normalized display price — daily rate for rentals, sale price for sale-only listings. Never both null (see listings_type_pricing_chk). */
function normalizedPrice(l: Listing): number {
  return l.daily_rate ?? l.sale_price ?? 0
}

/**
 * Applied to every REAL public marketplace query path (browse, homepage,
 * similar-listings) so a QA/DEMO/regression fixture never appears on a
 * surface a real visitor can reach. Deliberately NOT applied to
 * getListingsByMerchant()'s private-dashboard call sites (those opt in
 * via `{ includeTest: true }` instead) or to getListing()'s single-id
 * lookup (an unlisted, non-indexed fixture detail page staying directly
 * reachable by its owner/QA scripts is fine — see docs/SEO_HARDENING.md).
 */
export function excludeTestListings<T extends { eq: (column: string, value: unknown) => T }>(query: T): T {
  return query.eq('is_test', false)
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
    if (filters.mode === 'rent') {
      results = results.filter((l) => (l.listing_type ?? 'rental') === 'rental' || l.listing_type === 'both')
    } else if (filters.mode === 'buy') {
      results = results.filter((l) => l.listing_type === 'sale' || l.listing_type === 'both')
    }
    if (filters.countryId) {
      results = results.filter((l) => l.country_id === filters.countryId)
    }
    if (filters.minPrice !== undefined) {
      results = results.filter((l) => l.daily_rate !== null && l.daily_rate >= filters.minPrice!)
    }
    if (filters.maxPrice !== undefined) {
      results = results.filter((l) => l.daily_rate !== null && l.daily_rate <= filters.maxPrice!)
    }

    switch (filters.sort) {
      case 'price_asc':
        results.sort((a, b) => normalizedPrice(a) - normalizedPrice(b))
        break
      case 'price_desc':
        results.sort((a, b) => normalizedPrice(b) - normalizedPrice(a))
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

  let query = excludeTestListings(
    supabase
      .from('listings')
      .select('*, merchant:profiles!listings_merchant_id_fkey(*), media:listing_media(*)')
      .eq('status', 'active')
  )

  if (filters.category) query = query.eq('category', filters.category)
  if (filters.query) query = query.ilike('title', `%${filters.query}%`)
  if (filters.minPrice !== undefined) query = query.gte('daily_rate', filters.minPrice)
  if (filters.maxPrice !== undefined) query = query.lte('daily_rate', filters.maxPrice)
  if (filters.mode === 'rent') query = query.in('listing_type', ['rental', 'both'])
  if (filters.mode === 'buy') query = query.in('listing_type', ['sale', 'both'])
  if (filters.countryId) query = query.eq('country_id', filters.countryId)

  const { data: rawData } = await query
  if (!rawData) return []

  // Exclude barter-locked listings from browse — getListing() (single
  // detail fetch) deliberately does NOT apply this exclusion, so a
  // locked listing's own page still renders (with a "committed to a
  // barter" state), it just disappears from search/browse results. See
  // the Barter Marketplace MVP Implementation Plan, Decision 4.
  const { getAllBarterLockedListingIds } = await import('@/lib/barter/listing-lock')
  const lockedIds = await getAllBarterLockedListingIds()
  const data = lockedIds.size > 0 ? rawData.filter((l) => !lockedIds.has(l.id)) : rawData

  switch (filters.sort) {
    case 'price_asc':
      data.sort((a, b) => normalizedPrice(a) - normalizedPrice(b))
      break
    case 'price_desc':
      data.sort((a, b) => normalizedPrice(b) - normalizedPrice(a))
      break
    case 'rating':
      data.sort((a, b) => (b.merchant?.unity_score ?? 0) - (a.merchant?.unity_score ?? 0))
      break
    // 'newest'/'relevance' already match the default query order (created_at desc via no explicit order = insertion order is not guaranteed, but this matches the pre-existing behavior — no sort clause was applied server-side before this change either).
  }

  return data
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
    .select('*, merchant:profiles!listings_merchant_id_fkey(*), media:listing_media(*)')
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

  const { data } = await excludeTestListings(
    supabase
      .from('listings')
      .select('*, merchant:profiles!listings_merchant_id_fkey(*), media:listing_media(*)')
      .eq('status', 'active')
  )
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

/**
 * `includeTest` defaults to false (safe default -- excludes the caller's
 * own QA/DEMO fixtures) since most callers of this function are public or
 * semi-public surfaces (a merchant's public profile grid, a barter
 * propose-trade candidate list). Only a merchant's own private listings-
 * management dashboard passes `includeTest: true` explicitly, so their
 * own test fixture (e.g. the [DEMO] Affiliate Camera Listing) stays
 * visible to them there.
 */
export async function getListingsByMerchant(merchantId: string, options: { includeTest?: boolean } = {}): Promise<Listing[]> {
  if (IS_MOCK_MODE) {
    return MOCK_LISTINGS.filter((l) => l.merchant_id === merchantId)
  }

  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  if (!supabase) return []

  let query = supabase
    .from('listings')
    .select('*, merchant:profiles!listings_merchant_id_fkey(*), media:listing_media(*)')
    .eq('merchant_id', merchantId)
    .order('created_at', { ascending: false })

  if (!options.includeTest) query = query.eq('is_test', false)

  const { data } = await query

  return data ?? []
}

export async function getProfileReviews(revieweeId: string) {
  if (IS_MOCK_MODE) {
    return MOCK_REVIEWS.filter((r) => r.reviewee_id === revieweeId)
  }

  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  if (!supabase) return []

  // `reviews` has two FK relationships to `profiles` (reviewer_id,
  // reviewee_id), so a bare `profiles(*)` embed is ambiguous to
  // PostgREST (error PGRST201) -- the same failure class fixed for
  // `listings` during Unity SEO Pre-Launch Hardening. Qualify with the
  // exact FK constraint name, confirmed live via PostgREST's own error
  // hint.
  const { data } = await supabase
    .from('reviews')
    .select('*, reviewer:profiles!reviews_reviewer_id_fkey(*)')
    .eq('reviewee_id', revieweeId)
    .order('created_at', { ascending: false })

  return data ?? []
}

export function getAverageRating(reviews: { rating: number }[]): number {
  if (!reviews.length) return 0
  return reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length
}

export interface ListingDraft {
  listing: Listing
  requirements: Record<string, unknown> | null
  privateCategoryMetadata: Record<string, string | undefined>
  availability: { id: string; start_date: string; end_date: string; reason: string | null }[]
  /** @deprecated use requirements.requested_deposit_amount — kept for callers not yet updated */
  requestedDepositAmount: number | null
}

/**
 * Loads an existing draft for the wizard's edit mode (Phase 2A closure —
 * `?edit={id}` on the create-listing page). Returns null if the listing
 * doesn't exist, isn't owned by `merchantId`, or is no longer a draft —
 * RLS ("listings: public read active", allows `auth.uid() = merchant_id`
 * regardless of status) already scopes reads to the caller's own row, but
 * the ownership/status check here is explicit so the wizard can show a
 * clear "not found" state rather than silently rendering nothing.
 */
export async function getListingDraftForEdit(listingId: string, merchantId: string): Promise<ListingDraft | null> {
  if (IS_MOCK_MODE) return null // no mock draft fixtures — edit mode is exercised against real Supabase only

  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  if (!supabase) return null

  const { data: listing } = await supabase
    .from('listings')
    .select('*, media:listing_media(*)')
    .eq('id', listingId)
    .eq('merchant_id', merchantId)
    .eq('status', 'draft')
    .single()

  if (!listing) return null

  const [{ data: requirements }, { data: privateDetails }, { data: availability }] = await Promise.all([
    supabase.from('listing_requirements').select('*').eq('listing_id', listingId).maybeSingle(),
    supabase.from('listing_private_details').select('private_category_metadata').eq('listing_id', listingId).maybeSingle(),
    supabase.from('listing_availability').select('id, start_date, end_date, reason').eq('listing_id', listingId).order('start_date'),
  ])

  return {
    listing,
    requirements: requirements ?? null,
    privateCategoryMetadata: (privateDetails?.private_category_metadata ?? {}) as Record<string, string | undefined>,
    availability: availability ?? [],
    requestedDepositAmount: (requirements?.requested_deposit_amount as number | null) ?? null,
  }
}
