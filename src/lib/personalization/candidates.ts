import type { SupabaseClient } from '@supabase/supabase-js'
import { getAllBarterLockedListingIds } from '@/lib/barter/listing-lock'
import { isRentToBuyEnabled } from '@/lib/rent-to-buy/config'
import type { PersonalizationMode, RecommendationCandidate } from './types'

/**
 * Candidate sourcing (Section 27): mirrors the EXACT public-eligibility
 * conditions Search Ranking's own RPCs and the barter public view already
 * enforce -- never a weaker client-side re-implementation, and never a
 * call back into Search Ranking's RPCs themselves (Section 7: this stays
 * a fully separate discovery path).
 */

function listingModeFromType(listingType: string | null): PersonalizationMode | null {
  if (listingType === 'sale') return 'buy'
  if (listingType === 'rental') return 'rent'
  return null // 'both' is genuinely ambiguous for a single-mode affinity signal
}

export async function getListingCandidates(supabase: SupabaseClient, countryId: string, excludeEntityIds: Set<string> = new Set()): Promise<RecommendationCandidate[]> {
  const lockedIds = await getAllBarterLockedListingIds()

  const { data, error } = await supabase
    .from('listings')
    .select('id, merchant_id, category, listing_type, province, city, created_at')
    .eq('status', 'active')
    .eq('is_test', false)
    .eq('direction', 'available')
    .eq('country_id', countryId)
    .order('created_at', { ascending: false })
    .limit(200)

  if (error || !data) return []

  return data
    .filter((row) => !lockedIds.has(row.id) && !excludeEntityIds.has(row.id))
    .map((row) => ({
      entityType: 'listing' as const,
      entityId: row.id,
      mode: listingModeFromType(row.listing_type),
      category: row.category,
      kind: 'item' as const,
      province: row.province,
      city: row.city,
      merchantId: row.merchant_id,
      createdAt: row.created_at,
    }))
}

export async function getRequestCandidates(supabase: SupabaseClient, countryId: string, excludeEntityIds: Set<string> = new Set()): Promise<RecommendationCandidate[]> {
  const { data, error } = await supabase
    .from('marketplace_requests')
    .select('id, requester_id, category, transaction_type, province, city, created_at')
    .eq('is_test', false)
    .in('status', ['active', 'offers_received'])
    .eq('country_id', countryId)
    .order('created_at', { ascending: false })
    .limit(200)

  if (error || !data) return []

  return data
    .filter((row) => !excludeEntityIds.has(row.id))
    .map((row) => ({
      entityType: 'marketplace_request' as const,
      entityId: row.id,
      mode: (row.transaction_type as PersonalizationMode) ?? null,
      category: row.category,
      kind: 'item' as const,
      province: row.province,
      city: row.city,
      merchantId: row.requester_id,
      createdAt: row.created_at,
    }))
}

/** Reads the already-public, already-filtered
 * barter_skill_task_public_posts VIEW directly -- never the base table,
 * matching the same privacy/eligibility boundary the public Barter
 * browse UI itself relies on. RTB is unrelated to this entity type;
 * included here only because RENT_TO_BUY_ENABLED gating is centralized
 * in this file alongside the other candidate sources for readability. */
export async function getSkillTaskCandidates(supabase: SupabaseClient, excludeEntityIds: Set<string> = new Set()): Promise<RecommendationCandidate[]> {
  const { data, error } = await supabase
    .from('barter_skill_task_public_posts')
    .select('id, owner_id, kind, direction, category_id, province, city, created_at')
    .order('created_at', { ascending: false })
    .limit(200)

  if (error || !data) return []

  return data
    .filter((row) => !excludeEntityIds.has(row.id))
    .map((row) => ({
      entityType: 'barter_skill_task_post' as const,
      entityId: row.id,
      mode: 'barter' as const,
      category: row.category_id,
      kind: row.kind === 'skill' || row.kind === 'task' ? row.kind : null,
      province: row.province,
      city: row.city,
      merchantId: row.owner_id,
      createdAt: row.created_at,
    }))
}

/** RTB candidates are listings with an enabled rent_to_buy_listing_terms
 * row -- serve only when RENT_TO_BUY_ENABLED=true (Section 29), never
 * bypassed by personalization. */
export async function getRtbEligibleListingIds(supabase: SupabaseClient): Promise<Set<string>> {
  if (!isRentToBuyEnabled()) return new Set()
  const { data } = await supabase.from('rent_to_buy_listing_terms').select('listing_id').eq('enabled', true)
  return new Set((data ?? []).map((r) => r.listing_id))
}
