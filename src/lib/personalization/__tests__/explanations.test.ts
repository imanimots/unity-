import { describe, it, expect } from 'vitest'
import { primaryReasonCode, reasonMessageKey } from '../explanations'
import type { RecommendationReasonCode } from '../types'

const ALL_REASON_CODES: RecommendationReasonCode[] = [
  'recently_viewed',
  'preferred_category',
  'preferred_mode',
  'preferred_kind',
  'completed_similar',
  'location_match',
  'newest',
]

describe('recommendation explanations (category: stable reason codes)', () => {
  it('1. every reason code maps to a real, non-empty i18n message key', () => {
    for (const code of ALL_REASON_CODES) {
      const key = reasonMessageKey(code)
      expect(key).toBeTruthy()
      expect(key.startsWith('personalization.reasons.')).toBe(true)
    }
  })

  it('2. primaryReasonCode returns the first reason when present', () => {
    expect(primaryReasonCode({ reasonCodes: ['preferred_category', 'location_match'] })).toBe('preferred_category')
  })

  it('3. primaryReasonCode falls back to "newest" when reasonCodes is empty -- never throws, never fabricates a specific reason', () => {
    expect(primaryReasonCode({ reasonCodes: [] })).toBe('newest')
  })

  it('4. no reason message key ever references raw behavioral history (privacy: Section 33 "no raw user-history leak")', () => {
    for (const code of ALL_REASON_CODES) {
      const key = reasonMessageKey(code)
      expect(key).not.toMatch(/history|timeline|log/i)
    }
  })
})
