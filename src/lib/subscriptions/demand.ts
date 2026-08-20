import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Minimum aggregate volume before a bucket is surfaced to a merchant
 * (Section 27) -- prevents inferring one individual's search activity
 * from a displayed trend. Applied on READ, not write (the underlying
 * search_demand_aggregates table stores every real bucket regardless of
 * size; this threshold only governs what's safe to SHOW). Chosen as a
 * conservative round number for a new, low-volume marketplace -- worth
 * revisiting once real production search volume is known.
 */
export const DEMAND_INSIGHTS_MIN_SEARCH_COUNT = 10

export interface DemandCategoryTrend {
  category: string | null
  mode: string | null
  searchCount: number
  zeroResultCount: number
  zeroResultShare: number
}

export interface DemandInsightsResult {
  windowDays: number
  trends: DemandCategoryTrend[]
  hasSufficientData: boolean
}

/**
 * Pro/Elite demand intelligence (Section 24-29). Reads ONLY the
 * aggregate telemetry table -- never Search Ranking, never Personalization,
 * never a raw per-user row of any kind. Buckets below the privacy
 * threshold are excluded entirely (not merely hidden -- never returned),
 * and is_test buckets are always excluded (Section 86: QA traffic must
 * never appear as "trending").
 */
export async function getDemandInsights(supabase: SupabaseClient, windowDays = 30): Promise<DemandInsightsResult> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

  const { data, error } = await supabase
    .from('search_demand_aggregates')
    .select('mode, category, search_count, zero_result_count')
    .eq('is_test', false)
    .gte('day', since)

  if (error || !data) return { windowDays, trends: [], hasSufficientData: false }

  const grouped = new Map<string, { mode: string | null; category: string | null; searchCount: number; zeroResultCount: number }>()
  for (const row of data) {
    const key = `${row.mode ?? ''}|${row.category ?? ''}`
    const existing = grouped.get(key) ?? { mode: row.mode, category: row.category, searchCount: 0, zeroResultCount: 0 }
    existing.searchCount += row.search_count
    existing.zeroResultCount += row.zero_result_count
    grouped.set(key, existing)
  }

  const trends = [...grouped.values()]
    .filter((g) => g.searchCount >= DEMAND_INSIGHTS_MIN_SEARCH_COUNT)
    .map((g) => ({
      category: g.category,
      mode: g.mode,
      searchCount: g.searchCount,
      zeroResultCount: g.zeroResultCount,
      zeroResultShare: g.searchCount > 0 ? g.zeroResultCount / g.searchCount : 0,
    }))
    .sort((a, b) => b.searchCount - a.searchCount)

  return { windowDays, trends, hasSufficientData: trends.length > 0 }
}
