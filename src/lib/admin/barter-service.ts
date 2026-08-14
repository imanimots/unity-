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
  anchorListingId: string | null
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
  // Skills + Tasks under Barter -- anchor_listing_id is now nullable
  // (an agreement may be anchored by a Skill/Task post instead), so
  // null values must be filtered out before the .in() lookup below.
  const listingIds = Array.from(new Set(rows.map((r) => r.anchor_listing_id).filter((id): id is string => !!id)))
  const skillTaskPostIds = Array.from(new Set(rows.map((r) => r.source_skill_task_post_id).filter((id): id is string => !!id)))

  const [{ data: profiles }, { data: listings }, { data: skillTaskPosts }] = await Promise.all([
    admin.from('profiles').select('id, full_name, display_name').in('id', userIds),
    listingIds.length ? admin.from('listings').select('id, title').in('id', listingIds) : Promise.resolve({ data: [] }),
    skillTaskPostIds.length ? admin.from('barter_skill_task_posts').select('id, title').in('id', skillTaskPostIds) : Promise.resolve({ data: [] }),
  ])

  const nameById = new Map((profiles ?? []).map((p) => [p.id, p.full_name ?? p.display_name]))
  const titleById = new Map((listings ?? []).map((l) => [l.id, l.title]))
  const skillTaskTitleById = new Map((skillTaskPosts ?? []).map((p) => [p.id, p.title]))

  let results: AdminBarterRow[] = rows.map((r) => ({
    id: r.id,
    agreementReference: r.agreement_reference,
    status: r.status,
    partyAId: r.party_a_id,
    partyAName: nameById.get(r.party_a_id) ?? null,
    partyBId: r.party_b_id,
    partyBName: nameById.get(r.party_b_id) ?? null,
    anchorListingId: r.anchor_listing_id,
    anchorListingTitle: r.anchor_listing_id
      ? (titleById.get(r.anchor_listing_id) ?? null)
      : (skillTaskTitleById.get(r.source_skill_task_post_id) ?? null),
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
  /** Skills + Tasks under Barter -- the accepted offer's items (any kind), each with its contribution_details/milestones embedded, for the read-only admin progress view. Empty when there's no accepted offer or it's item-only. */
  acceptedSkillTaskItems: Record<string, unknown>[]
  depositTerms: Record<string, unknown>[]
  evidenceByMilestone: Record<string, Record<string, unknown>[]>
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

  const offerIds = (offers ?? []).map((o) => o.id)
  let acceptedSkillTaskItems: Record<string, unknown>[] = []
  let depositTerms: Record<string, unknown>[] = []
  const evidenceByMilestone: Record<string, Record<string, unknown>[]> = {}

  if (agreement.accepted_offer_id) {
    const { data: items } = await admin
      .from('barter_offer_items')
      .select('*, contribution_details:barter_contribution_details(*), milestones:barter_contribution_milestones(*)')
      .eq('offer_id', agreement.accepted_offer_id)
      .neq('kind', 'item')

    acceptedSkillTaskItems = (items ?? []).map((item) => ({
      ...item,
      contribution_details: Array.isArray(item.contribution_details) ? item.contribution_details[0] : item.contribution_details,
    }))

    const milestoneIds = acceptedSkillTaskItems.flatMap((i) => ((i.milestones as Record<string, unknown>[] | undefined) ?? []).map((m) => m.id as string))
    if (milestoneIds.length) {
      const { data: evidenceRows } = await admin.from('barter_milestone_evidence').select('*').in('milestone_id', milestoneIds).order('created_at', { ascending: true })
      for (const row of evidenceRows ?? []) {
        const list = evidenceByMilestone[row.milestone_id] ?? []
        list.push(row)
        evidenceByMilestone[row.milestone_id] = list
      }
    }
  }

  if (offerIds.length) {
    const { data: terms } = await admin.from('barter_deposit_terms').select('*').in('offer_id', offerIds)
    depositTerms = terms ?? []
  }

  return {
    agreement,
    offers: offers ?? [],
    history: history ?? [],
    confirmations: confirmations ?? [],
    payments: payments ?? [],
    acceptedSkillTaskItems,
    depositTerms,
    evidenceByMilestone,
  }
}
