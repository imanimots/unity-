import type { SupabaseClient } from '@supabase/supabase-js'
import { getEffectiveMerchantPlan } from './effective-plan'

export interface ListingEntitlementUsage {
  activeCount: number
  limit: number | null
  atLimit: boolean
  planId: string
}

/**
 * TS-side mirror of activate_listing()'s own cap check (Real listings
 * only -- is_test fixtures are excluded from the count entirely, same as
 * the RPC), used purely for display ("X/5 listings used", a disabled
 * "List an item" affordance) -- never itself an enforcement point. The
 * RPC is the only real gate; this can drift by a few seconds under
 * concurrent activation without being a security problem, same as every
 * other "readiness" display helper in this codebase
 * (deriveFinancialReadiness, deriveBarterFinancialReadiness).
 */
export async function getListingEntitlementUsage(supabase: SupabaseClient, merchantId: string): Promise<ListingEntitlementUsage> {
  const { plan, planId } = await getEffectiveMerchantPlan(supabase, merchantId)

  const { count, error } = await supabase
    .from('listings')
    .select('id', { count: 'exact', head: true })
    .eq('merchant_id', merchantId)
    .eq('status', 'active')
    .eq('is_test', false)

  if (error) throw error

  const activeCount = count ?? 0
  const limit = plan.active_listing_limit
  return {
    activeCount,
    limit,
    atLimit: limit !== null && activeCount >= limit,
    planId,
  }
}
