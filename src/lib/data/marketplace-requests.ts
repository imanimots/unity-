import type { SupabaseClient } from '@supabase/supabase-js'
import type { MarketplaceRequestSummary } from '@/components/listings/request-card'

export interface MarketplaceRequestFilters {
  transactionType?: 'buy' | 'rent' | 'barter' | 'rent_to_buy'
  category?: string
  query?: string
  countryId?: string
  sort?: 'newest' | 'budget_asc' | 'budget_desc'
}

/** Public browse of published, non-test Looking For requests — mirrors getListings()'s shape. */
export async function getMarketplaceRequests(filters: MarketplaceRequestFilters = {}): Promise<MarketplaceRequestSummary[]> {
  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  if (!supabase) return []

  let query = supabase
    .from('marketplace_requests')
    .select('id, transaction_type, title, category, province, city, budget_min, budget_max, currency, start_date, end_date, expires_at, created_at')
    .eq('is_test', false)
    .in('status', ['active', 'offers_received'])

  if (filters.transactionType) query = query.eq('transaction_type', filters.transactionType)
  if (filters.category) query = query.eq('category', filters.category)
  if (filters.countryId) query = query.eq('country_id', filters.countryId)
  if (filters.query) query = query.ilike('title', `%${filters.query}%`)

  if (filters.sort === 'budget_asc') query = query.order('budget_min', { ascending: true, nullsFirst: false })
  else if (filters.sort === 'budget_desc') query = query.order('budget_max', { ascending: false, nullsFirst: false })
  else query = query.order('created_at', { ascending: false })

  const { data, error } = await query.limit(60)
  if (error) return []
  return (data ?? []) as MarketplaceRequestSummary[]
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
