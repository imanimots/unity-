import type { AnalyticsEventName } from './events'

export interface SearchExecutionFacts {
  hasExecutedSearch: boolean
  resultCount: number
  filterCount: number
  hasQuery: boolean
  category?: string
}

export interface DecidedSearchEvent {
  eventName: AnalyticsEventName
  metadata: Record<string, string | number | boolean>
}

/**
 * Pure decision logic for the D2-F1 remediation's client-side search
 * tracker (ADMIN-CONTROL-CENTRE-BATCH-D2-F1) -- extracted so it can be
 * unit-tested directly without a jsdom/component-test harness (this
 * repo's vitest config has neither). The actual tracker component just
 * calls this once per genuine mount/route-identity change and emits
 * whatever it returns via trackEvent() -- no decision logic lives in
 * the component itself.
 *
 * For a passive default browse (no query, no meaningful filter),
 * returns an empty array -- never emits search_started for a bare
 * page visit. For a real executed search, always returns exactly
 * search_started followed by exactly one of search_results_viewed /
 * search_zero_results, matching the one-search-one-outcome semantics
 * the admin Behavior & Conversion funnel assumes.
 */
export function decideSearchEvents(facts: SearchExecutionFacts): DecidedSearchEvent[] {
  if (!facts.hasExecutedSearch) return []

  const categoryMetadata: Record<string, string> = facts.category ? { category: facts.category } : {}

  const events: DecidedSearchEvent[] = [
    { eventName: 'search_started', metadata: { has_query: facts.hasQuery, filter_count: facts.filterCount, ...categoryMetadata } },
  ]

  events.push(
    facts.resultCount === 0
      ? { eventName: 'search_zero_results', metadata: { has_query: facts.hasQuery, ...categoryMetadata } }
      : { eventName: 'search_results_viewed', metadata: { result_count: facts.resultCount, has_query: facts.hasQuery, ...categoryMetadata } }
  )

  return events
}
