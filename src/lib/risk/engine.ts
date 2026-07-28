/**
 * Unity Risk Engine — client-side mirror of the server-side risk computation.
 *
 * Source of truth is the Postgres trigger `compute_listing_risk_tier()`
 * (supabase/migrations/20260720000002_risk_engine.sql), which recalculates
 * `listings.risk_tier` on every insert/update and ignores any client-supplied
 * value for that column — merchants and renters cannot override it.
 *
 * This module exists so the UI (listing wizard, listing detail, booking flow)
 * can preview/display the same tier and its consequences without a round trip.
 * Keep the two rule sets in sync — see docs/RISK_ENGINE.md.
 */

import type { KycStatus } from '@/types'

export type RiskTier = 'low' | 'medium' | 'high'
export type ListingTypeForRisk = 'rental' | 'sale'

export interface RiskInput {
  listingType?: ListingTypeForRisk
  category: string
  dailyRate?: number | null
  salePrice?: number | null
  merchantKycStatus: KycStatus
  merchantUnityScore: number
}

export interface RiskRequirements {
  tier: RiskTier
  ownershipVerificationRequired: boolean
  inspectionVideoRequired: boolean
  depositRequired: boolean
  depositRecommended: boolean
  insuranceRequired: boolean
  manualReviewRequired: boolean
}

const TIER_RANK: Record<RiskTier, number> = { low: 0, medium: 1, high: 2 }
const RANK_TIER: RiskTier[] = ['low', 'medium', 'high']

// Categories whose inherent risk profile puts a floor under the value-based tier,
// regardless of the price/rate — e.g. a cheap vehicle rental is still high risk.
const CATEGORY_RISK_FLOOR: Record<string, RiskTier> = {
  vehicles: 'high',
  tech: 'medium',
  tools: 'medium',
  fashion: 'medium',
  music: 'medium',
  outdoor: 'low',
  events: 'low',
  sports: 'low',
  baby: 'low',
}

// Value thresholds are intentionally separate per listing type — a R2,500/day
// rental and a R2,500 one-time sale represent very different exposure.
const RENTAL_VALUE_THRESHOLDS = { medium: 500, high: 2500 } // ZAR per day
const SALE_VALUE_THRESHOLDS = { medium: 3000, high: 15000 } // ZAR total

function valueTier(amount: number, thresholds: { medium: number; high: number }): RiskTier {
  if (amount >= thresholds.high) return 'high'
  if (amount >= thresholds.medium) return 'medium'
  return 'low'
}

/**
 * Automatically determines a listing's risk tier. Not user-configurable —
 * any UI that calls this is producing a preview, not an assignment.
 */
export function calculateRiskTier(input: RiskInput): RiskTier {
  const listingType = input.listingType ?? 'rental'

  const byValue =
    listingType === 'sale'
      ? valueTier(input.salePrice ?? 0, SALE_VALUE_THRESHOLDS)
      : valueTier(input.dailyRate ?? 0, RENTAL_VALUE_THRESHOLDS)

  const categoryFloor = CATEGORY_RISK_FLOOR[input.category] ?? 'low'

  let tierRank = Math.max(TIER_RANK[byValue], TIER_RANK[categoryFloor])

  // Trust modifier: an unverified or low-standing merchant raises risk by one
  // tier regardless of the item itself.
  const merchantIsLowTrust = input.merchantKycStatus !== 'approved' || input.merchantUnityScore < 3.0
  if (merchantIsLowTrust) {
    tierRank = Math.min(tierRank + 1, TIER_RANK.high)
  }

  return RANK_TIER[tierRank]
}

/** Consequences of a given risk tier, per the Phase 1 architecture spec. */
export function getRiskRequirements(tier: RiskTier): RiskRequirements {
  switch (tier) {
    case 'low':
      return {
        tier,
        ownershipVerificationRequired: false,
        inspectionVideoRequired: false,
        depositRequired: false,
        depositRecommended: false,
        insuranceRequired: false,
        manualReviewRequired: false,
      }
    case 'medium':
      return {
        tier,
        ownershipVerificationRequired: true,
        inspectionVideoRequired: true,
        depositRequired: false,
        depositRecommended: true,
        insuranceRequired: false,
        manualReviewRequired: false,
      }
    case 'high':
      return {
        tier,
        ownershipVerificationRequired: true,
        inspectionVideoRequired: true,
        depositRequired: true,
        depositRecommended: true,
        insuranceRequired: true,
        manualReviewRequired: true,
      }
  }
}

export const RISK_TIER_LABELS: Record<RiskTier, string> = {
  low: 'Low Risk',
  medium: 'Medium Risk',
  high: 'High Risk',
}
