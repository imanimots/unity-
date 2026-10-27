import { describe, it, expect } from 'vitest'
import { decideSearchEvents } from '../search-events'

// Pure decision-logic tests for the D2-F1 client-side search tracker
// (ADMIN-CONTROL-CENTRE-BATCH-D2-F1) -- extracted specifically so this
// logic is testable without a jsdom/component-test harness (this
// repo's vitest config has neither).
describe('decideSearchEvents (category: ADMIN-CONTROL-CENTRE-BATCH-D2-F1)', () => {
  it('1. emits nothing for a passive default browse (no executed search)', () => {
    expect(decideSearchEvents({ hasExecutedSearch: false, resultCount: 0, filterCount: 0, hasQuery: false })).toEqual([])
  })

  it('2. emits nothing even if resultCount/filterCount happen to be nonzero, when hasExecutedSearch is false', () => {
    expect(decideSearchEvents({ hasExecutedSearch: false, resultCount: 20, filterCount: 2, hasQuery: true })).toEqual([])
  })

  it('3. a completed search with results emits exactly search_started then search_results_viewed', () => {
    const events = decideSearchEvents({ hasExecutedSearch: true, resultCount: 5, filterCount: 1, hasQuery: true, category: 'tools' })
    expect(events).toHaveLength(2)
    expect(events[0]).toEqual({ eventName: 'search_started', metadata: { has_query: true, filter_count: 1, category: 'tools' } })
    expect(events[1]).toEqual({ eventName: 'search_results_viewed', metadata: { result_count: 5, has_query: true, category: 'tools' } })
  })

  it('4. a completed search with zero results emits exactly search_started then search_zero_results (never results_viewed)', () => {
    const events = decideSearchEvents({ hasExecutedSearch: true, resultCount: 0, filterCount: 0, hasQuery: true })
    expect(events).toHaveLength(2)
    expect(events[0].eventName).toBe('search_started')
    expect(events[1]).toEqual({ eventName: 'search_zero_results', metadata: { has_query: true } })
  })

  it('5. never emits both search_results_viewed and search_zero_results for the same decision', () => {
    const zero = decideSearchEvents({ hasExecutedSearch: true, resultCount: 0, filterCount: 0, hasQuery: false })
    const nonZero = decideSearchEvents({ hasExecutedSearch: true, resultCount: 1, filterCount: 0, hasQuery: false })
    expect(zero.map((e) => e.eventName)).not.toContain('search_results_viewed')
    expect(nonZero.map((e) => e.eventName)).not.toContain('search_zero_results')
  })

  it('6. omits the category field entirely when no category is given, rather than sending an empty/undefined value', () => {
    const events = decideSearchEvents({ hasExecutedSearch: true, resultCount: 1, filterCount: 0, hasQuery: false })
    expect('category' in events[0].metadata).toBe(false)
    expect('category' in events[1].metadata).toBe(false)
  })

  it('7. never includes a raw free-text query field anywhere in the decided events', () => {
    const events = decideSearchEvents({ hasExecutedSearch: true, resultCount: 3, filterCount: 2, hasQuery: true, category: 'electronics' })
    for (const event of events) {
      expect('q' in event.metadata).toBe(false)
      expect('query' in event.metadata).toBe(false)
      expect('search_text' in event.metadata).toBe(false)
    }
  })
})
