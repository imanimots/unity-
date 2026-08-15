import type { SupabaseClient } from '@supabase/supabase-js'
import type { MarketplaceRequestSummary } from '@/components/listings/request-card'
import { normalizeSearchQuery, decodeSearchCursor, encodeSearchCursor, computeSearchContextHash, isCursorValidForContext, resolveDefaultSort, type SearchCursor } from '@/lib/search/cursor'

export interface MarketplaceRequestFilters {
  transactionType?: 'buy' | 'rent' | 'barter' | 'rent_to_buy'
  category?: string
  query?: string
  countryId?: string
  sort?: 'newest' | 'budget_asc' | 'budget_desc' | 'relevance'
  /** Opaque cursor from a previous MarketplaceRequestsPage.nextCursor. */
  cursor?: string
  /** Defaults to 24. */
  limit?: number
}

export interface MarketplaceRequestsPage {
  items: MarketplaceRequestSummary[]
  nextCursor: string | null
}

function requestsSearchContextParams(filters: MarketplaceRequestFilters, resolvedSort: string, normalizedQuery: string | null) {
  return {
    query: normalizedQuery,
    transactionType: filters.transactionType ?? null,
    category: filters.category ?? null,
    countryId: filters.countryId ?? null,
    sort: resolvedSort,
  }
}

/**
 * Public browse of published, non-test Looking For requests — calls
 * the `search_marketplace_requests` SQL RPC (Search Ranking MVP), so
 * the previous unconditional `.limit(60)` ceiling no longer silently
 * truncates results; pagination is now cursor-based (nextCursor).
 */
export async function getMarketplaceRequestsPage(filters: MarketplaceRequestFilters = {}): Promise<MarketplaceRequestsPage> {
  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  if (!supabase) return { items: [], nextCursor: null }

  const normalizedQuery = normalizeSearchQuery(filters.query)
  const resolvedSort = resolveDefaultSort(filters.sort, normalizedQuery)
  const limit = filters.limit ?? 24
  const contextParams = requestsSearchContextParams(filters, resolvedSort, normalizedQuery)
  const contextHash = computeSearchContextHash('marketplace_requests', contextParams)

  const decodedCursor = filters.cursor ? decodeSearchCursor(filters.cursor) : null
  const cursor: SearchCursor | null = decodedCursor && isCursorValidForContext(decodedCursor, 'marketplace_requests', contextParams) ? decodedCursor : null

  const { data: ranked, error: rpcError } = await supabase.rpc('search_marketplace_requests', {
    p_query: normalizedQuery,
    p_transaction_type: filters.transactionType ?? null,
    p_category: filters.category ?? null,
    p_country_id: filters.countryId ?? null,
    p_sort: resolvedSort,
    p_cursor_tier: cursor?.tier ?? null,
    p_cursor_score: cursor?.score ?? null,
    p_cursor_budget: cursor?.price ?? null,
    p_cursor_created_at: cursor?.createdAt ?? null,
    p_cursor_id: cursor?.id ?? null,
    p_limit: limit,
  })

  if (rpcError || !ranked || ranked.length === 0) return { items: [], nextCursor: null }

  type RankedRow = { id: string; match_tier: number; match_score: number; budget_min: number | null; budget_max: number | null; created_at: string }
  const rankedRows = ranked as RankedRow[]
  const ids = rankedRows.map((r) => r.id)

  const { data: rawData } = await supabase
    .from('marketplace_requests')
    .select('id, transaction_type, title, category, province, city, budget_min, budget_max, currency, start_date, end_date, expires_at, created_at')
    .in('id', ids)

  const byId = new Map(((rawData ?? []) as MarketplaceRequestSummary[]).map((r) => [r.id, r]))
  const items = ids.map((id) => byId.get(id)).filter((r): r is MarketplaceRequestSummary => Boolean(r))

  const last = rankedRows[rankedRows.length - 1]
  // Must mirror the RPC's own per-sort cursor field exactly: budget_asc
  // compares against budget_min, budget_desc against budget_max — see
  // search_marketplace_requests in the ranking RPC migration.
  const cursorBudget = resolvedSort === 'budget_desc' ? last.budget_max : last.budget_min
  const nextCursor =
    rankedRows.length === limit
      ? encodeSearchCursor({ tier: last.match_tier, score: last.match_score, price: cursorBudget, createdAt: last.created_at, id: last.id, contextHash })
      : null

  return { items, nextCursor }
}

/** Convenience wrapper over getMarketplaceRequestsPage() for callers that only need the first page. */
export async function getMarketplaceRequests(filters: MarketplaceRequestFilters = {}): Promise<MarketplaceRequestSummary[]> {
  const page = await getMarketplaceRequestsPage(filters)
  return page.items
}

/**
 * Shared by GET /api/marketplace/requests/[id] and the server-rendered
 * detail page -- one implementation, not a self-fetch (which would need
 * to manually forward session cookies to preserve isOwner detection).
 * Takes a service-role client (never RLS-bypassing on the caller's
 * behalf -- ownership/visibility are enforced explicitly here).
 */
export async function getMarketplaceRequestDetail(admin: SupabaseClient, requestId: string, viewerUserId: string | null) {
  const { data: req } = await admin.from('marketplace_requests').select('*').eq('id', requestId).maybeSingle()
  if (!req) return null

  const isOwner = viewerUserId === req.requester_id
  if (req.status === 'draft' && !isOwner) return null
  if (req.is_test && !isOwner) return null

  const { data: requesterProfile } = await admin.from('profiles').select('full_name, display_name, kyc_status').eq('id', req.requester_id).maybeSingle()

  let offers: unknown[] = []
  if (isOwner) {
    const { data } = await admin.from('marketplace_request_offers').select('*').eq('request_id', requestId).order('created_at', { ascending: false })
    offers = data ?? []
  } else if (viewerUserId) {
    const { data } = await admin.from('marketplace_request_offers').select('*').eq('request_id', requestId).eq('responder_id', viewerUserId)
    offers = data ?? []
  }

  return {
    request: req,
    requesterName: requesterProfile?.full_name ?? requesterProfile?.display_name ?? 'Unity user',
    requesterVerified: requesterProfile?.kyc_status === 'approved',
    isOwner,
    offers,
  }
}
