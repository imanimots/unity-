import type { SupabaseClient } from '@supabase/supabase-js'

const DEFAULT_LIMIT = 100

export interface AdminMarketplaceRequestRow {
  id: string
  transactionType: string
  status: string
  title: string
  requesterId: string
  requesterName: string | null
  offerCount: number
  matchedOfferId: string | null
  createdAt: string
}

export interface AdminMarketplaceRequestFilters {
  search?: string
  transactionType?: string
  status?: string
  limit?: number
}

/** Mirrors listAdminEscrowTransactions' exact shape -- one base query + Promise.all of related lookups + in-memory joins. */
export async function listAdminMarketplaceRequests(admin: SupabaseClient, filters: AdminMarketplaceRequestFilters): Promise<AdminMarketplaceRequestRow[]> {
  let query = admin
    .from('marketplace_requests')
    .select('id, transaction_type, status, title, requester_id, matched_offer_id, created_at')
    .order('created_at', { ascending: false })
    .limit(filters.limit ?? DEFAULT_LIMIT)

  if (filters.status && filters.status !== 'all') query = query.eq('status', filters.status)
  if (filters.transactionType && filters.transactionType !== 'all') query = query.eq('transaction_type', filters.transactionType)

  const { data: rows, error } = await query
  if (error) throw error
  if (!rows || rows.length === 0) return []

  const requesterIds = Array.from(new Set(rows.map((r) => r.requester_id)))
  const [{ data: profiles }, { data: offerCounts }] = await Promise.all([
    admin.from('profiles').select('id, full_name, display_name').in('id', requesterIds),
    admin.from('marketplace_request_offers').select('request_id').in('request_id', rows.map((r) => r.id)),
  ])
  const nameById = new Map((profiles ?? []).map((p) => [p.id, p.full_name ?? p.display_name]))
  const countByRequest = new Map<string, number>()
  for (const o of offerCounts ?? []) countByRequest.set(o.request_id, (countByRequest.get(o.request_id) ?? 0) + 1)

  let results: AdminMarketplaceRequestRow[] = rows.map((r) => ({
    id: r.id, transactionType: r.transaction_type, status: r.status, title: r.title,
    requesterId: r.requester_id, requesterName: nameById.get(r.requester_id) ?? null,
    offerCount: countByRequest.get(r.id) ?? 0, matchedOfferId: r.matched_offer_id, createdAt: r.created_at,
  }))

  if (filters.search && filters.search.trim()) {
    const q = filters.search.trim().toLowerCase()
    results = results.filter((r) => r.title.toLowerCase().includes(q) || (r.requesterName ?? '').toLowerCase().includes(q))
  }

  return results
}

export interface AdminMarketplaceRequestDetail {
  request: Record<string, unknown>
  requesterName: string | null
  offers: Record<string, unknown>[]
  history: Record<string, unknown>[]
}

export async function getAdminMarketplaceRequestDetail(admin: SupabaseClient, requestId: string): Promise<AdminMarketplaceRequestDetail | null> {
  const { data: req, error } = await admin.from('marketplace_requests').select('*').eq('id', requestId).maybeSingle()
  if (error) throw error
  if (!req) return null

  const [{ data: profile }, { data: offers }, { data: history }] = await Promise.all([
    admin.from('profiles').select('full_name, display_name').eq('id', req.requester_id).maybeSingle(),
    admin.from('marketplace_request_offers').select('*').eq('request_id', requestId).order('created_at', { ascending: false }),
    admin.from('marketplace_request_history').select('*').eq('request_id', requestId).order('created_at', { ascending: false }),
  ])

  return {
    request: req,
    requesterName: profile?.full_name ?? profile?.display_name ?? null,
    offers: offers ?? [],
    history: history ?? [],
  }
}
