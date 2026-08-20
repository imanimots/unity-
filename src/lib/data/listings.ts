import type { SupabaseClient } from '@supabase/supabase-js'
import type { Listing } from '@/types'
import {
  MOCK_LISTINGS,
  MOCK_REVIEWS,
  IS_MOCK_MODE,
} from '@/lib/mock/data'
import { normalizeSearchQuery, decodeSearchCursor, encodeSearchCursor, computeSearchContextHash, isCursorValidForContext, resolveDefaultSort, type SearchCursor } from '@/lib/search/cursor'
import { getSponsoredListingSlot, spliceSponsoredListing } from '@/lib/advertising/search-insertion'

export interface ListingFilters {
  category?: string
  query?: string
  minPrice?: number
  maxPrice?: number
  location?: string
  sort?: 'relevance' | 'price_asc' | 'price_desc' | 'newest' | 'rating'
  /**
   * Maps the browse-page Buy/Rent toggle to listing_type. 'rent' ->
   * rental|both, 'buy' -> sale|both. 'rent_to_buy' filters to listings
   * with an enabled 1:1 rent_to_buy_listing_terms row (not a
   * listing_type value -- RTB terms can sit on a sale/rental/both
   * listing alike). Omit for no type filtering (barter's own browse
   * omits mode entirely, matching Phase 4's precedent).
   */
  mode?: 'buy' | 'rent' | 'rent_to_buy'
  /**
   * Scopes results to one country (public browse/search only — see
   * resolveEffectiveCountry()). Omit to skip country filtering entirely —
   * used deliberately by getListingsByMerchant() and any internal/admin
   * lookup, which must never lose a row just because the browsing
   * country changed.
   */
  countryId?: string
  /** Opaque cursor from a previous ListingsPage.nextCursor — see src/lib/search/cursor.ts. Ignored (treated as first page) if it doesn't match the current filter context. */
  cursor?: string
  /** Defaults to 24. */
  limit?: number
}

export interface ListingsPage {
  items: Listing[]
  nextCursor: string | null
}

function listingsSearchContextParams(filters: ListingFilters, resolvedSort: string, normalizedQuery: string | null) {
  return {
    query: normalizedQuery,
    mode: filters.mode ?? null,
    category: filters.category ?? null,
    countryId: filters.countryId ?? null,
    minPrice: filters.minPrice ?? null,
    maxPrice: filters.maxPrice ?? null,
    sort: resolvedSort,
  }
}

/** Normalized display price — daily rate for rentals, sale price for sale-only listings. Never both null (see listings_type_pricing_chk). */
function normalizedPrice(l: Listing): number {
  return l.daily_rate ?? l.sale_price ?? 0
}

/**
 * The `merchant`/`reviewer` identity attached to a listing/review is
 * NEVER read via a `profiles!*_fkey(...)` PostgREST embed and never a
 * bare `profiles(*)` embed. `profiles` itself is no longer even
 * directly SELECT-able by anon/authenticated for another user's row
 * (its RLS is `auth.uid() = id` -- see
 * supabase/migrations/20260831000001_profiles_privacy_boundary.sql),
 * and PostgREST embeds are subject to the EMBEDDED table's own RLS as
 * the querying role, so an embed here would silently return null for
 * every listing's merchant. Instead, every function below batch-fetches
 * identities from the `public_profiles` view (id, display_name,
 * full_name, avatar_url, role, is_verified, unity_score, created_at --
 * never phone/kyc_status/account_status/affiliate fields) via
 * `attachMerchantIdentities()`/`attachReviewerIdentities()` and joins
 * in-memory, matching this codebase's own dominant admin-service
 * pattern (one base query + a batched related-table query + a Map
 * join) rather than relying on an embed at all. See
 * docs/CLICKABLE_PROFILES.md.
 */
async function fetchPublicProfilesById(supabase: SupabaseClient, ids: string[]): Promise<Map<string, Record<string, unknown>>> {
  const uniqueIds = [...new Set(ids)].filter(Boolean)
  if (uniqueIds.length === 0) return new Map()
  const initial = await supabase.from('public_profiles').select('id, display_name, full_name, avatar_url, role, is_verified, unity_score, created_at, is_elite, public_business_name').in('id', uniqueIds)
  // Subscription V2's is_elite/public_business_name columns may not
  // exist yet in an environment where that migration hasn't been
  // applied -- fall back to the pre-V2 column set rather than losing
  // merchant/reviewer identity on every listing.
  let data = initial.data
  if (initial.error && /is_elite|public_business_name/.test(initial.error.message)) {
    const fallback = await supabase.from('public_profiles').select('id, display_name, full_name, avatar_url, role, is_verified, unity_score, created_at').in('id', uniqueIds)
    data = (fallback.data ?? []).map((p) => ({ ...p, is_elite: false, public_business_name: null }))
  }
  return new Map(((data ?? []) as { id: string }[]).map((p) => [p.id, p as Record<string, unknown>]))
}

async function attachMerchantIdentities<T extends { merchant_id: string }>(supabase: SupabaseClient, rows: T[]): Promise<(T & { merchant?: Record<string, unknown> })[]> {
  const byId = await fetchPublicProfilesById(supabase, rows.map((r) => r.merchant_id))
  return rows.map((r) => ({ ...r, merchant: byId.get(r.merchant_id) }))
}

async function attachReviewerIdentities<T extends { reviewer_id: string }>(supabase: SupabaseClient, rows: T[]): Promise<(T & { reviewer?: Record<string, unknown> })[]> {
  const byId = await fetchPublicProfilesById(supabase, rows.map((r) => r.reviewer_id))
  return rows.map((r) => ({ ...r, reviewer: byId.get(r.reviewer_id) }))
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

/**
 * Advertising MVP: splices at most one sponsored listing into an
 * already-final organic page (never touches p_limit/match_tier/
 * match_score/cursor -- see src/lib/advertising/search-insertion.ts's
 * own header comment for the full invariant). A no-op entirely
 * (returns `items` unchanged) whenever ADVERTISING_ENABLED is not
 * "true" -- organic search results are then byte-identical to before
 * this phase, which is exactly what the permanent structural
 * neutrality regression proves.
 */
async function maybeInsertSponsoredListing(supabase: SupabaseClient, items: Listing[], filters: ListingFilters): Promise<Listing[]> {
  if (items.length === 0) return items
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const slot = await getSponsoredListingSlot(
    supabase,
    { mode: filters.mode, category: filters.category, countryId: filters.countryId, query: filters.query },
    items.map((i) => i.id),
    user?.id ?? null
  )
  if (!slot) return items

  const merged = await spliceSponsoredListing(items, slot, async (listingId) => {
    const { data } = await supabase.from('listings').select('*, media:listing_media(*)').eq('id', listingId).maybeSingle()
    if (!data) return null
    const [withMerchant] = await attachMerchantIdentities(supabase, [data])
    return withMerchant
  })
  return merged as Listing[]
}

/** Convenience wrapper over getListingsPage() for callers that only need the first page (homepage featured grid, tests). */
export async function getListings(filters: ListingFilters = {}): Promise<Listing[]> {
  const page = await getListingsPage(filters)
  return page.items
}

/**
 * Real-Supabase path calls the `search_listings` SQL RPC (Search
 * Ranking MVP) — all filtering/tier-classification/sorting/pagination
 * happens in Postgres now, not in this function. `sort: 'rating'` is
 * deliberately NOT routed through the RPC (it has no `rating` sort
 * option — a genuine review-aware "Top Rated" ranking was judged not
 * worth building for this phase, see the implementation report) and
 * keeps the prior legacy full-fetch + in-memory sort-by-unity_score
 * behavior, used only by the homepage's small "featured" grid, never
 * paginated. It is intentionally excluded from the public browse
 * page's selectable sort options.
 */
export async function getListingsPage(filters: ListingFilters = {}): Promise<ListingsPage> {
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

    return { items: results.slice(0, filters.limit ?? 24), nextCursor: null }
  }

  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  if (!supabase) return { items: [], nextCursor: null }

  // Legacy path, unchanged from before this phase — 'rating' has no
  // RPC sort equivalent (see the function doc comment above).
  if (filters.sort === 'rating') {
    let query = excludeTestListings(
      supabase
        .from('listings')
        .select('*, media:listing_media(*)')
        .eq('status', 'active')
    )
    if (filters.category) query = query.eq('category', filters.category)
    if (filters.query) query = query.ilike('title', `%${filters.query}%`)
    if (filters.minPrice !== undefined) query = query.gte('daily_rate', filters.minPrice)
    if (filters.maxPrice !== undefined) query = query.lte('daily_rate', filters.maxPrice)
    if (filters.mode === 'rent') query = query.in('listing_type', ['rental', 'both'])
    if (filters.mode === 'buy') query = query.in('listing_type', ['sale', 'both'])
    if (filters.countryId) query = query.eq('country_id', filters.countryId)
    if (filters.mode === 'rent_to_buy') {
      const { data: rtbTerms } = await supabase.from('rent_to_buy_listing_terms').select('listing_id').eq('enabled', true)
      const rtbListingIds = (rtbTerms ?? []).map((t) => t.listing_id)
      if (rtbListingIds.length === 0) return { items: [], nextCursor: null }
      query = query.in('id', rtbListingIds)
    }
    const { data: rawData } = await query
    if (!rawData) return { items: [], nextCursor: null }
    const { getAllBarterLockedListingIds } = await import('@/lib/barter/listing-lock')
    const lockedIds = await getAllBarterLockedListingIds()
    const filtered = lockedIds.size > 0 ? rawData.filter((l) => !lockedIds.has(l.id)) : rawData
    const data = await attachMerchantIdentities(supabase, filtered)
    data.sort((a, b) => (b.merchant?.unity_score ?? 0) - (a.merchant?.unity_score ?? 0))
    return { items: data.slice(0, filters.limit ?? 24), nextCursor: null }
  }

  const normalizedQuery = normalizeSearchQuery(filters.query)
  const resolvedSort = resolveDefaultSort(filters.sort, normalizedQuery)
  const limit = filters.limit ?? 24
  const contextParams = listingsSearchContextParams(filters, resolvedSort, normalizedQuery)
  const contextHash = computeSearchContextHash('listings', contextParams)

  const decodedCursor = filters.cursor ? decodeSearchCursor(filters.cursor) : null
  const cursor: SearchCursor | null = decodedCursor && isCursorValidForContext(decodedCursor, 'listings', contextParams) ? decodedCursor : null

  const { data: ranked, error: rpcError } = await supabase.rpc('search_listings', {
    p_query: normalizedQuery,
    p_mode: filters.mode ?? null,
    p_category: filters.category ?? null,
    p_country_id: filters.countryId ?? null,
    p_price_min: filters.minPrice ?? null,
    p_price_max: filters.maxPrice ?? null,
    p_sort: resolvedSort,
    p_cursor_tier: cursor?.tier ?? null,
    p_cursor_score: cursor?.score ?? null,
    p_cursor_price: cursor?.price ?? null,
    p_cursor_created_at: cursor?.createdAt ?? null,
    p_cursor_id: cursor?.id ?? null,
    p_limit: limit,
  })

  if (rpcError || !ranked || ranked.length === 0) return { items: [], nextCursor: null }

  type RankedRow = { id: string; match_tier: number; match_score: number; price: number | null; created_at: string }
  const rankedRows = ranked as RankedRow[]
  const ids = rankedRows.map((r) => r.id)

  const { data: rawData } = await supabase.from('listings').select('*, media:listing_media(*)').in('id', ids)
  const byId = new Map((rawData ?? []).map((l) => [l.id, l]))
  const orderedRaw = ids.map((id) => byId.get(id)).filter((l): l is NonNullable<typeof l> => Boolean(l))

  const items = await attachMerchantIdentities(supabase, orderedRaw)

  // Organic cursor is computed from `rankedRows` (the untouched organic
  // RPC result) BEFORE any sponsored splice below -- ads never
  // participate in cursor state, per the Advertising MVP's absolute
  // organic-search invariant.
  const last = rankedRows[rankedRows.length - 1]
  const nextCursor =
    rankedRows.length === limit
      ? encodeSearchCursor({ tier: last.match_tier, score: last.match_score, price: last.price, createdAt: last.created_at, id: last.id, contextHash })
      : null

  const finalItems = await maybeInsertSponsoredListing(supabase, items, filters)

  return { items: finalItems, nextCursor }
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
    .select('*, media:listing_media(*)')
    .eq('id', id)
    .single()

  if (!data) return null
  const [withMerchant] = await attachMerchantIdentities(supabase, [data])
  return withMerchant
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
      .select('*, media:listing_media(*)')
      .eq('status', 'active')
  )
    .eq('category', listing.category)
    .neq('id', listing.id)
    .limit(limit)

  return data ? attachMerchantIdentities(supabase, data) : []
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
    .select('*, media:listing_media(*)')
    .eq('merchant_id', merchantId)
    .order('created_at', { ascending: false })

  if (!options.includeTest) query = query.eq('is_test', false)

  const { data } = await query

  return data ? attachMerchantIdentities(supabase, data) : []
}

export async function getProfileReviews(revieweeId: string) {
  if (IS_MOCK_MODE) {
    return MOCK_REVIEWS.filter((r) => r.reviewee_id === revieweeId)
  }

  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  if (!supabase) return []

  const { data } = await supabase
    .from('reviews')
    .select('*')
    .eq('reviewee_id', revieweeId)
    .order('created_at', { ascending: false })

  return data ? attachReviewerIdentities(supabase, data) : []
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
