import { getAdminServiceClient } from '@/lib/admin/route-helpers'

/**
 * Records ONE aggregate search-demand bucket increment (Section 24-27).
 * Deliberately separate from, and never imported by, any Search Ranking
 * file -- this is called from the browse PAGE, after Search Ranking has
 * already produced its final result set, and never influences it in
 * any way (fire-and-forget, result is discarded, errors are swallowed).
 * No user_id, no IP, no raw query text, no city -- only mode/category/
 * province buckets, matching the privacy-conservative scope documented
 * in the migration.
 */
export async function recordSearchDemandEvent(params: { mode?: string | null; category?: string | null; province?: string | null; zeroResult: boolean; isTest?: boolean }): Promise<void> {
  try {
    const admin = await getAdminServiceClient()
    if (!admin) return
    await admin.rpc('record_search_demand_event', {
      p_mode: params.mode ?? null,
      p_category: params.category ?? null,
      p_province: params.province ?? null,
      p_zero_result: params.zeroResult,
      p_is_test: params.isTest ?? false,
    })
  } catch {
    // Telemetry must never break the browse page.
  }
}
