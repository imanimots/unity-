import type { SupabaseClient } from '@supabase/supabase-js'
import type { Listing } from '@/types'
import { getListingCandidates } from './candidates'
import { rankCandidates, rankContinueBrowsing } from './recommendations'
import { primaryReasonCode } from './explanations'
import type { PersonalizationProfileInput, RecommendationModule, ScoredRecommendation } from './types'

/**
 * Orchestrates candidate sourcing + deterministic ranking + hydration
 * into full `Listing` rows, so the UI layer can reuse the existing
 * `<ListingCard>` component unchanged. V1 renders listing candidates
 * only (the homepage's existing discovery surface is listings-only
 * today) -- the scoring engine and candidate model
 * (recommendations.ts/candidates.ts) are already entity-type-agnostic
 * for Looking For / Skill/Task, which is future UI work, not an engine
 * limitation.
 */
export interface RecommendationResult {
  module: RecommendationModule
  listing: Listing
  reasonCode: ScoredRecommendation['reasonCodes'][number]
  reasonContext: ScoredRecommendation['reasonContext']
}

async function hydrateListings(supabase: SupabaseClient, scored: { entityId: string }[]): Promise<Map<string, Listing>> {
  if (scored.length === 0) return new Map()
  const { data } = await supabase
    .from('listings')
    .select('*, media:listing_media(*)')
    .in(
      'id',
      scored.map((s) => s.entityId)
    )
  const map = new Map<string, Listing>()
  for (const row of (data ?? []) as Listing[]) map.set(row.id, row)
  return map
}

export async function getRecommendationModule(
  supabase: SupabaseClient,
  options: {
    module: RecommendationModule
    profile: PersonalizationProfileInput
    viewerId: string | null
    countryId: string
    limit?: number
  }
): Promise<RecommendationResult[]> {
  const limit = options.limit ?? 12
  const viewedEntityIds = new Set(options.profile.views.filter((v) => v.entityType === 'listing').map((v) => v.entityId))

  if (options.module === 'continue_browsing') {
    const eligible = await getListingCandidates(supabase, options.countryId)
    const eligibleIds = new Set(eligible.map((c) => c.entityId))
    const ranked = rankContinueBrowsing(
      options.profile.views.filter((v) => v.entityType === 'listing'),
      eligibleIds,
      limit
    )
    const hydrated = await hydrateListings(
      supabase,
      ranked.map((r) => ({ entityId: r.entityId }))
    )
    return ranked
      .map((r): RecommendationResult | null => {
        const listing = hydrated.get(r.entityId)
        if (!listing) return null
        return { module: options.module, listing, reasonCode: 'recently_viewed', reasonContext: { category: r.category ?? undefined } }
      })
      .filter((r): r is RecommendationResult => r !== null)
  }

  const candidates = await getListingCandidates(supabase, options.countryId, options.module === 'because_you_viewed' ? new Set() : viewedEntityIds)
  const scored = rankCandidates(candidates, options.profile, { module: options.module, viewerId: options.viewerId, limit })
  const hydrated = await hydrateListings(supabase, scored)

  return scored
    .map((s) => {
      const listing = hydrated.get(s.entityId)
      if (!listing) return null
      return { module: options.module, listing, reasonCode: primaryReasonCode(s), reasonContext: s.reasonContext }
    })
    .filter((r): r is RecommendationResult => r !== null)
}
