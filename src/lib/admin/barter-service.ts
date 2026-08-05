import type { SupabaseClient } from '@supabase/supabase-js'

const DEFAULT_LIMIT = 100

export interface AdminBarterRow {
  id: string
  agreementReference: string
  status: string
  partyAId: string
  partyAName: string | null
  partyBId: string
  partyBName: string | null
  anchorListingId: string
  anchorListingTitle: string | null
  adminHold: boolean
  createdAt: string
  updatedAt: string
}

export interface AdminBarterFilters {
  status?: string
  search?: string
  limit?: number
}

/**
 * Mirrors listAdminDisputes' exact shape (disputes-service.ts): one base
 * query + Promise.all of related rows + in-memory joins, no separate
 * "service class".
 */
export async function listAdminBarterAgreements(admin: SupabaseClient, filters: AdminBarterFilters): Promise<AdminBarterRow[]> {
  let query = admin
    .from('barter_agreements')
    .select('*')
    .order('proposed_at', { ascending: false })
    .limit(filters.limit ?? DEFAULT_LIMIT)

  if (filters.status && filters.status !== 'all') query = query.eq('status', filters.status)

  const { data: rows, error } = await query
  if (error) throw error
  if (!rows || rows.length === 0) return []

  const userIds = Array.from(new Set(rows.flatMap((r) => [r.party_a_id, r.party_b_id])))
  const listingIds = Array.from(new Set(rows.map((r) => r.anchor_listing_id)))

  const [{ data: profiles }, { data: listings }] = await Promise.all([
    admin.from('profiles').select('id, full_name, display_name').in('id', userIds),
    listingIds.length ? admin.from('listings').select('id, title').in('id', listingIds) : Promise.resolve({ data: [] }),
  ])

  const nameById = new Map((profiles ?? []).map((p) => [p.id, p.full_name ?? p.display_name]))
  const titleById = new Map((listings ?? []).map((l) => [l.id, l.title]))

  let results: AdminBarterRow[] = rows.map((r) => ({
    id: r.id,
    agreementReference: r.agreement_reference,
    status: r.status,
    partyAId: r.party_a_id,
    partyAName: nameById.get(r.party_a_id) ?? null,
    partyBId: r.party_b_id,
    partyBName: nameById.get(r.party_b_id) ?? null,
    anchorListingId: r.anchor_listing_id,
    anchorListingTitle: titleById.get(r.anchor_listing_id) ?? null,
    adminHold: r.admin_hold,
    createdAt: r.proposed_at,
    updatedAt: r.updated_at,
  }))

  if (filters.search) {
    const q = filters.search.toLowerCase()
    results = results.filter(
      (a) =>
        a.agreementReference.toLowerCase().includes(q) ||
        (a.partyAName ?? '').toLowerCase().includes(q) ||
        (a.partyBName ?? '').toLowerCase().includes(q) ||
        (a.anchorListingTitle ?? '').toLowerCase().includes(q)
    )
  }

  return results
}

export interface AdminBarterDetail {
  agreement: Record<string, unknown>
  offers: Record<string, unknown>[]
  history: Record<string, unknown>[]
  confirmations: Record<string, unknown>[]
  payments: Record<string, unknown>[]
}

export async function getAdminBarterDetail(admin: SupabaseClient, agreementId: string): Promise<AdminBarterDetail | null> {
  const { data: agreement } = await admin.from('barter_agreements').select('*').eq('id', agreementId).maybeSingle()
  if (!agreement) return null

  const [{ data: offers }, { data: history }, { data: confirmations }, { data: payments }] = await Promise.all([
    admin.from('barter_offers').select('*').eq('agreement_id', agreementId).order('version', { ascending: true }),
    admin.from('barter_history').select('*').eq('agreement_id', agreementId).order('created_at', { ascending: true }),
    admin.from('barter_confirmations').select('*').eq('agreement_id', agreementId),
    admin.from('payments').select('*').eq('barter_agreement_id', agreementId),
  ])

  return {
    agreement,
    offers: offers ?? [],
    history: history ?? [],
    confirmations: confirmations ?? [],
    payments: payments ?? [],
  }
}
