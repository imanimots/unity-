import type { SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'
import { isAdvertisingEnabled } from './config'
import { isRentToBuyEnabled } from '@/lib/rent-to-buy/config'

/**
 * Search-result ad insertion (Advertising MVP §6/§16-18 of the
 * authoritative prompt). ABSOLUTE INVARIANT: this module is called
 * strictly AFTER the organic search_listings/search_marketplace_requests/
 * search_skill_task_posts RPC call and its cursor have already been
 * computed -- it never touches p_limit, match_tier, match_score, or the
 * organic cursor in any way. Ads are a pure presentation-layer splice
 * over an already-final organic page.
 *
 * Density: one sponsored slot per result page (the safest, most
 * conservative option evaluated during the audit phase -- see the
 * Advertising architecture report §45), inserted at a fixed position
 * (index 3, i.e. after the 3rd organic card) -- always far under the
 * binding 60% hard ceiling, which is nonetheless enforced explicitly
 * below rather than assumed.
 */

const SPONSORED_SLOT_POSITION = 3
const MAX_AD_DENSITY_RATIO = 0.6

export interface SponsoredListingResult {
  sponsored: true
  campaignId: string
  listingId: string
  impressionId: string | null
}

/**
 * Returns at most one sponsored listing candidate for the 'search_result'
 * placement, already impression-recorded (server-selected impression
 * definition, per the architecture report §34) and deduplicated against
 * whatever organic listing IDs are already on this page (§9/§18 -- never
 * show the same listing twice on one page).
 */
export async function getSponsoredListingSlot(
  supabase: SupabaseClient,
  context: { mode?: string; category?: string; countryId?: string; query?: string },
  organicListingIds: string[],
  viewerId: string | null
): Promise<SponsoredListingResult | null> {
  if (!isAdvertisingEnabled()) return null

  const reachKey = viewerId ? `viewer:${viewerId}` : `anon:${randomUUID()}`

  const { data, error } = await supabase.rpc('get_eligible_ads', {
    p_placement_type: 'search_result',
    p_mode: context.mode ?? null,
    p_direction: 'available',
    p_kind: 'item',
    p_category: context.category ?? null,
    p_keywords: context.query ? [context.query] : [],
    p_country_id: context.countryId ?? null,
    p_exclude_listing_ids: organicListingIds,
    p_exclude_marketplace_request_ids: [],
    p_exclude_barter_skill_task_post_ids: [],
    p_rent_to_buy_enabled: isRentToBuyEnabled(),
    p_limit: 1,
  })

  if (error || !data || data.length === 0) return null
  const candidate = data.find((row: { target_type: string; listing_id: string | null }) => row.target_type === 'listing' && row.listing_id)
  if (!candidate) return null

  const { data: impressionResult } = await supabase.rpc('record_ad_impression', {
    p_campaign_id: candidate.campaign_id,
    p_placement_type: 'search_result',
    p_viewer_id: viewerId,
    p_reach_key: reachKey,
  })

  const impressionId = impressionResult?.recorded ? (impressionResult.impression_id as string) : null
  // If recording failed (e.g. the campaign was paused between selection
  // and this call), do not present it as a sponsored slot at all --
  // never show an ad Unity cannot account for.
  if (!impressionResult?.recorded) return null

  return { sponsored: true, campaignId: candidate.campaign_id, listingId: candidate.listing_id, impressionId }
}

/**
 * Splices at most one sponsored listing into an already-finalized
 * organic items array, at a fixed presentation position, enforcing the
 * binding 60% maximum paid-density ceiling server-authoritatively
 * (never relying on layout/CSS). `fetchListing` resolves the sponsored
 * listing's own full display row via the caller's existing safe data
 * layer (never a bespoke ad-specific listing fetch) -- if the listing
 * cannot be resolved (e.g. it just became ineligible), the slot is
 * silently dropped rather than rendering a broken card.
 */
export async function spliceSponsoredListing<T extends { id: string }>(
  organicItems: T[],
  sponsoredSlot: SponsoredListingResult | null,
  fetchListing: (id: string) => Promise<T | null>
): Promise<Array<T & { sponsored?: true; adCampaignId?: string; adImpressionId?: string }>> {
  if (!sponsoredSlot) return organicItems

  const maxAdSlots = Math.floor(organicItems.length * MAX_AD_DENSITY_RATIO)
  if (maxAdSlots < 1) return organicItems // page too small to safely add a paid slot under the 60% ceiling

  const sponsoredListing = await fetchListing(sponsoredSlot.listingId)
  if (!sponsoredListing) return organicItems

  const merged = organicItems.slice()
  const insertAt = Math.min(SPONSORED_SLOT_POSITION, merged.length)
  merged.splice(insertAt, 0, {
    ...sponsoredListing,
    sponsored: true,
    adCampaignId: sponsoredSlot.campaignId,
    adImpressionId: sponsoredSlot.impressionId ?? undefined,
  })

  return merged
}
