import type { MerchantSubscriptionPlan } from '@/types'

/**
 * Section 53: the "what you'll lose/change" checklist, generated from
 * the ACTUAL entitlement diff between two plans -- never a hardcoded
 * list, so it can never go stale relative to the real plan matrix and
 * only ever shows items genuinely relevant to this specific
 * current -> target transition. Every key returned here must be present
 * in the downgrade request's acknowledgedChangeKeys before the server
 * will schedule the change (Section 52 Step 5) -- this same function
 * runs on both the client (to render the checklist) and the server (to
 * validate the acknowledgement), so they can never drift apart.
 */
export function computeDowngradeChangeKeys(current: MerchantSubscriptionPlan, target: MerchantSubscriptionPlan): string[] {
  const keys: string[] = []
  const currentLimit = current.active_publication_limit ?? Infinity
  const targetLimit = target.active_publication_limit ?? Infinity

  if (targetLimit < currentLimit) keys.push('publicationLimit')
  if (target.sales_commission_bps > current.sales_commission_bps) keys.push('saleCommission')
  if (target.rental_commission_bps > current.rental_commission_bps) keys.push('rentalCommission')
  if (target.advertising_discount_bps < current.advertising_discount_bps) keys.push('advertisingDiscount')
  if (current.affiliate_enabled && !target.affiliate_enabled) keys.push('affiliate')
  if (current.analytics_level === 'full' && target.analytics_level === 'basic') keys.push('analytics')
  if (current.demand_insights_enabled && !target.demand_insights_enabled) keys.push('demandInsights')
  if (current.listing_assistant_enabled && !target.listing_assistant_enabled) keys.push('listingAssistant')
  if (current.analytics_assistant_enabled && !target.analytics_assistant_enabled) keys.push('analyticsAssistant')
  if (current.advanced_tools_enabled && !target.advanced_tools_enabled) keys.push('advancedTools')
  if (supportRank(target.support_level) < supportRank(current.support_level)) keys.push('support')
  if (current.business_name_enabled && !target.business_name_enabled) keys.push('businessName')
  if (current.elite_badge_enabled && !target.elite_badge_enabled) keys.push('eliteBadge')

  return keys
}

function supportRank(level: MerchantSubscriptionPlan['support_level']): number {
  return { standard: 0, priority: 1, highest: 2 }[level]
}

export const DOWNGRADE_REASON_CATEGORIES = ['too_expensive', 'not_using_features', 'switching_platform', 'business_paused', 'other'] as const
export type DowngradeReasonCategory = (typeof DOWNGRADE_REASON_CATEGORIES)[number]

/** Encodes the reason category as a stable, parseable prefix on the
 * free-text reason column -- avoids a new schema column while keeping
 * the category machine-readable for later retention analysis. */
export function encodeDowngradeReason(category: string, text: string | undefined): string {
  const trimmed = text?.trim()
  return trimmed ? `[${category}] ${trimmed}` : `[${category}]`
}
