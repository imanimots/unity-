import { describe, it, expect } from 'vitest'
import {
  recordAnonymousView,
  getAnonymousViews,
  clearAnonymousHistory,
  buildAnonymousViewRecords,
  markAnonymousHistoryMerged,
  hasUnmergedAnonymousHistory,
  ANONYMOUS_PERSONALIZATION_MAX_EVENTS,
  ANONYMOUS_PERSONALIZATION_RETENTION_DAYS,
} from '../anonymous'

// No jsdom in this project's vitest config (node environment only) --
// `window` is genuinely undefined here, which is exactly the condition
// every function in anonymous.ts must degrade safely under (Section 14:
// this module must never crash if it's ever reached during SSR despite
// being 'use client'). These tests prove that safety property directly
// rather than exercising real localStorage I/O.
describe('anonymous personalization (category: SSR safety)', () => {
  it('1. recordAnonymousView never throws when window is undefined', () => {
    expect(() =>
      recordAnonymousView({ entityType: 'listing', entityId: 'a', mode: 'rent', category: 'tech', kind: 'item', province: null, city: null })
    ).not.toThrow()
  })

  it('2. getAnonymousViews returns an empty array (never null/undefined) when window is undefined', () => {
    expect(getAnonymousViews()).toEqual([])
  })

  it('3. buildAnonymousViewRecords returns an empty array when window is undefined', () => {
    expect(buildAnonymousViewRecords()).toEqual([])
  })

  it('4. clearAnonymousHistory never throws when window is undefined', () => {
    expect(() => clearAnonymousHistory()).not.toThrow()
  })

  it('5. markAnonymousHistoryMerged never throws when window is undefined', () => {
    expect(() => markAnonymousHistoryMerged()).not.toThrow()
  })

  it('6. hasUnmergedAnonymousHistory is false (never a false positive) when window is undefined', () => {
    expect(hasUnmergedAnonymousHistory()).toBe(false)
  })
})

describe('anonymous personalization (category: documented bounds)', () => {
  it('7. the retention window is a finite, documented number of days (Section 15)', () => {
    expect(ANONYMOUS_PERSONALIZATION_RETENTION_DAYS).toBeGreaterThan(0)
    expect(ANONYMOUS_PERSONALIZATION_RETENTION_DAYS).toBeLessThanOrEqual(60)
  })

  it('8. the event cap is a finite, documented number (Section 15: bounded local storage)', () => {
    expect(ANONYMOUS_PERSONALIZATION_MAX_EVENTS).toBeGreaterThan(0)
    expect(ANONYMOUS_PERSONALIZATION_MAX_EVENTS).toBeLessThanOrEqual(500)
  })
})
