import { TIER_RANK, RANK_TIER } from '@/lib/risk/engine'
import type { RiskTier } from '@/lib/risk/engine'

/**
 * Barter's risk tier is the max of every offered listing's own
 * already-computed risk_tier (set by the existing compute_listing_risk_tier
 * trigger) -- no duplicated rank logic, no new BarterRiskInput shape.
 * Admin context only; does not gate acceptance.
 */
export function calculateBarterRiskTier(listingTiers: RiskTier[]): RiskTier {
  if (listingTiers.length === 0) return 'low'
  const maxRank = Math.max(...listingTiers.map((t) => TIER_RANK[t]))
  return RANK_TIER[maxRank]
}
