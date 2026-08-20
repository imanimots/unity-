import type { SupabaseClient } from '@supabase/supabase-js'
import type { MerchantAnalyticsLevel, MerchantSubscriptionPlanId, MerchantSupportLevel } from '@/types'
import { getEffectiveMerchantPlan } from './effective-plan'

/**
 * The ONE centralized, typed subscription entitlement model (Section
 * 64) -- every protected capability in the app resolves through this,
 * never a scattered `plan === 'elite'` check. Values are derived
 * directly from the live merchant_subscription_plans row (via
 * getEffectiveMerchantPlan, which is itself history-based and correct
 * for both "now" and any past atTime) -- nothing here is client-trusted
 * (Section 65): every server-side capability check calls this with the
 * caller's OWN resolved merchant id, never a client-supplied plan.
 *
 * Advanced tools (bulk management, duplicate, scheduled publishing,
 * bulk price updates, inventory/calendar, CSV import/export) share one
 * underlying `advanced_tools_enabled` column -- Pro and Elite get
 * identical tooling (Section 41), so there is no product reason for
 * seven independent flags in the database; they're still exposed as
 * seven independently named booleans here to match Section 64's
 * requested shape and to leave room for them to diverge later without
 * a further interface change.
 */
export interface MerchantEntitlements {
  planId: MerchantSubscriptionPlanId
  /** null = unlimited. Global cap across listings + marketplace_requests + barter_skill_task_posts. */
  publicationLimit: number | null
  saleCommissionRate: number
  rentalCommissionRate: number
  barterCommissionRate: number
  advertisingDiscountBps: number
  affiliateEnabled: boolean
  analyticsLevel: MerchantAnalyticsLevel
  demandInsightsEnabled: boolean
  listingAssistantEnabled: boolean
  analyticsAssistantEnabled: boolean
  bulkListingEnabled: boolean
  duplicateListingEnabled: boolean
  scheduledPublishingEnabled: boolean
  bulkPriceUpdateEnabled: boolean
  inventoryCalendarEnabled: boolean
  csvImportEnabled: boolean
  csvExportEnabled: boolean
  supportLevel: MerchantSupportLevel
  businessNameEnabled: boolean
  eliteBadgeEnabled: boolean
}

export async function getMerchantEntitlements(supabase: SupabaseClient, merchantId: string, atTime: Date = new Date()): Promise<MerchantEntitlements> {
  const { plan, planId } = await getEffectiveMerchantPlan(supabase, merchantId, atTime)

  return {
    planId,
    publicationLimit: plan.active_publication_limit,
    saleCommissionRate: plan.sales_commission_bps / 10000,
    rentalCommissionRate: plan.rental_commission_bps / 10000,
    barterCommissionRate: plan.barter_commission_bps / 10000,
    advertisingDiscountBps: plan.advertising_discount_bps,
    affiliateEnabled: plan.affiliate_enabled,
    analyticsLevel: plan.analytics_level,
    demandInsightsEnabled: plan.demand_insights_enabled,
    listingAssistantEnabled: plan.listing_assistant_enabled,
    analyticsAssistantEnabled: plan.analytics_assistant_enabled,
    bulkListingEnabled: plan.advanced_tools_enabled,
    duplicateListingEnabled: plan.advanced_tools_enabled,
    scheduledPublishingEnabled: plan.advanced_tools_enabled,
    bulkPriceUpdateEnabled: plan.advanced_tools_enabled,
    inventoryCalendarEnabled: plan.advanced_tools_enabled,
    csvImportEnabled: plan.advanced_tools_enabled,
    csvExportEnabled: plan.advanced_tools_enabled,
    supportLevel: plan.support_level,
    businessNameEnabled: plan.business_name_enabled,
    eliteBadgeEnabled: plan.elite_badge_enabled,
  }
}

export interface PublicationUsage {
  activeCount: number
  limit: number | null
  atLimit: boolean
  planId: string
}

/**
 * TS-side mirror of _lock_and_count_active_supply()'s combined count
 * (listings + marketplace_requests + barter_skill_task_posts, real
 * content only), used purely for display ("X/5 published, upgrade for
 * more") -- never itself an enforcement point. The SQL function inside
 * the publish/reactivate RPCs is the only real gate; this can drift by
 * a few seconds under concurrent activity without being a security
 * problem, same as every other "readiness" display helper in this
 * codebase (deriveFinancialReadiness, deriveBarterFinancialReadiness).
 */
export async function getPublicationUsage(supabase: SupabaseClient, merchantId: string): Promise<PublicationUsage> {
  const entitlements = await getMerchantEntitlements(supabase, merchantId)

  const [{ count: listingCount, error: listingError }, { count: requestCount, error: requestError }, { count: postCount, error: postError }] = await Promise.all([
    supabase.from('listings').select('id', { count: 'exact', head: true }).eq('merchant_id', merchantId).eq('status', 'active').eq('is_test', false),
    supabase.from('marketplace_requests').select('id', { count: 'exact', head: true }).eq('requester_id', merchantId).in('status', ['active', 'offers_received']).eq('is_test', false),
    supabase.from('barter_skill_task_posts').select('id', { count: 'exact', head: true }).eq('owner_id', merchantId).in('status', ['active', 'offers_received']).eq('is_test', false),
  ])

  if (listingError) throw listingError
  if (requestError) throw requestError
  if (postError) throw postError

  const activeCount = (listingCount ?? 0) + (requestCount ?? 0) + (postCount ?? 0)
  const limit = entitlements.publicationLimit

  return {
    activeCount,
    limit,
    atLimit: limit !== null && activeCount >= limit,
    planId: entitlements.planId,
  }
}
