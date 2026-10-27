'use client'

import { useEffect, useRef } from 'react'
import { trackEvent } from '@/lib/analytics/client'
import { decideSearchEvents, type SearchExecutionFacts } from '@/lib/analytics/search-events'

/**
 * D2-F1 remediation (ADMIN-CONTROL-CENTRE-BATCH-D2-F1): search_started/
 * search_results_viewed/search_zero_results moved out of the browse
 * page's Server Component render body for the same reason as
 * ListingViewTracker -- see that component's comment.
 *
 * The browse page (a Server Component) computes the safe, already-
 * final result facts (never raw query text) and passes them down as
 * props; this component only decides WHEN to emit (via the pure
 * decideSearchEvents() helper) and fires once per distinct `routeKey`
 * (the server-computed canonical query-param identity for this
 * search/browse request, NOT the raw free-text query). A rerender
 * with the same routeKey never re-fires (React re-render, Strict
 * Mode's dev double-effect); a genuinely new search/filter navigation
 * produces a new routeKey and correctly fires again, as does a true
 * page refresh of the same URL (fresh mount, ref resets to null).
 */
export function SearchAnalyticsTracker({ routeKey, ...facts }: SearchExecutionFacts & { routeKey: string }) {
  const lastFiredRouteKey = useRef<string | null>(null)

  useEffect(() => {
    if (!facts.hasExecutedSearch) return
    if (lastFiredRouteKey.current === routeKey) return
    lastFiredRouteKey.current = routeKey

    for (const event of decideSearchEvents(facts)) {
      trackEvent(event.eventName, { metadata: event.metadata })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey, facts.hasExecutedSearch, facts.resultCount, facts.filterCount, facts.hasQuery, facts.category])

  return null
}
