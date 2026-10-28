import type { SupabaseClient } from '@supabase/supabase-js'

export interface RealListingOverviewCounts {
  activeListings: number
  suspendedListings: number
}

/**
 * D3-D-F1: the 2 listing-derived Admin Overview metrics (Active/
 * Suspended listings), scoped to confirmed real listings only --
 * listings.is_test = false AND the owning merchant profile positively
 * real (listings.merchant_id -> profiles.id, FK
 * listings_merchant_id_fkey, the same relation src/app/api/admin/listings/route.ts
 * already uses). get_admin_overview_stats() itself counts every
 * listing with no classification awareness and this phase creates no
 * migration to edit that RPC in place -- same override pattern as
 * src/lib/admin/users-service.ts's getRealUserOverviewCounts. Preserves
 * the exact existing status definitions ('active'/'suspended') from
 * the RPC -- this changes WHO counts, never WHAT counts as active or
 * suspended.
 */
export async function getRealListingOverviewCounts(admin: SupabaseClient): Promise<RealListingOverviewCounts> {
  const scoped = (status: string) =>
    admin
      .from('listings')
      .select('id, profiles!listings_merchant_id_fkey!inner(data_classification)', { count: 'exact', head: true })
      .eq('is_test', false)
      .eq('profiles.data_classification', 'real')
      .eq('status', status)

  const [{ count: activeListings }, { count: suspendedListings }] = await Promise.all([scoped('active'), scoped('suspended')])

  return {
    activeListings: activeListings ?? 0,
    suspendedListings: suspendedListings ?? 0,
  }
}
