import type { SupabaseClient } from '@supabase/supabase-js'
import { classifyEntityWithOwners } from '@/lib/admin/data-scope'

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
 *
 * D3-D: real requires BOTH parties positively real -- party_a_id/
 * party_b_id -> profiles.id (FKs `barter_agreements_party_a_id_fkey`/
 * `barter_agreements_party_b_id_fkey`, confirmed from
 * supabase/migrations/20260810000003_barter_schema.sql). barter_agreements
 * has no is_test column of its own, and anchor_listing_id is deliberately
 * NOT treated as an authoritative test signal -- its own schema comment
 * documents it as "informational context only, not necessarily part of
 * the final offered item set" (a counter-offer may trade entirely
 * different items), so a test anchor listing would not reliably prove
 * the actual trade is test. Scoped via inner-joined, aliased profiles,
 * before `.limit()`.
 */
export async function listAdminBarterAgreements(admin: SupabaseClient, filters: AdminBarterFilters): Promise<AdminBarterRow[]> {
  let query = admin
    .from('barter_agreements')
    .select(
      `id, agreement_reference, status, party_a_id, party_b_id, anchor_listing_id, source_skill_task_post_id, admin_hold, proposed_at, updated_at,
      party_a_profile:profiles!barter_agreements_party_a_id_fkey!inner(data_classification),
      party_b_profile:profiles!barter_agreements_party_b_id_fkey!inner(data_classification)`
    )
    .eq('party_a_profile.data_classification', 'real')
    .eq('party_b_profile.data_classification', 'real')
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

  // D3-D: a known test/unknown-linked agreement id must not load as an
  // ordinary Real Data barter detail -- same positive-proof boundary as
  // the list above. Checked before offers/history/confirmations/payments.
  const { data: partyProfiles } = await admin
    .from('profiles')
    .select('id, data_classification')
    .in('id', [agreement.party_a_id, agreement.party_b_id])
  const partyA = partyProfiles?.find((p) => p.id === agreement.party_a_id)
  const partyB = partyProfiles?.find((p) => p.id === agreement.party_b_id)
  if (classifyEntityWithOwners({ is_test: false }, [partyA ?? {}, partyB ?? {}]) !== 'real') {
    return null
  }

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

export interface RealBarterOverviewCounts {
  proposedBarterAgreements: number
  acceptedBarterAgreements: number
  inProgressBarterAgreements: number
  disputedBarterAgreements: number
  adminHeldBarterAgreements: number
}

/**
 * D3-D-F1: the 5 barter-derived Admin Overview metrics, scoped to
 * confirmed real agreements only -- both parties positively real, the
 * exact same rule listAdminBarterAgreements already applies (no own
 * is_test column; anchor_listing_id deliberately not treated as
 * authoritative, same reasoning as the list). Preserves every existing
 * status grouping from get_admin_overview_stats() verbatim.
 */
export async function getRealBarterOverviewCounts(admin: SupabaseClient): Promise<RealBarterOverviewCounts> {
  const scoped = () =>
    admin
      .from('barter_agreements')
      .select(
        'id, party_a_profile:profiles!barter_agreements_party_a_id_fkey!inner(data_classification), party_b_profile:profiles!barter_agreements_party_b_id_fkey!inner(data_classification)',
        { count: 'exact', head: true }
      )
      .eq('party_a_profile.data_classification', 'real')
      .eq('party_b_profile.data_classification', 'real')

  const [
    { count: proposedBarterAgreements },
    { count: acceptedBarterAgreements },
    { count: inProgressBarterAgreements },
    { count: disputedBarterAgreements },
    { count: adminHeldBarterAgreements },
  ] = await Promise.all([
    scoped().in('status', ['proposed', 'countered']),
    scoped().eq('status', 'accepted'),
    scoped().in('status', ['preparing', 'in_transit', 'awaiting_confirmation']),
    scoped().eq('status', 'disputed'),
    scoped().eq('admin_hold', true),
  ])

  return {
    proposedBarterAgreements: proposedBarterAgreements ?? 0,
    acceptedBarterAgreements: acceptedBarterAgreements ?? 0,
    inProgressBarterAgreements: inProgressBarterAgreements ?? 0,
    disputedBarterAgreements: disputedBarterAgreements ?? 0,
    adminHeldBarterAgreements: adminHeldBarterAgreements ?? 0,
  }
}
