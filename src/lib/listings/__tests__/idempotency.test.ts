import { describe, it, expect } from 'vitest'
import { computeSubmitRequestHash } from '../idempotency'

describe('computeSubmitRequestHash', () => {
  it('matches the exact md5 Postgres produces for the same inputs', () => {
    // Cross-checked live against submit_listing_for_review()'s own formula:
    // select md5('11111111-1111-1111-1111-111111111111' || '|' ||
    //   array['ownership_authority','condition_accuracy']::declaration_type[]::text)
    const hash = computeSubmitRequestHash('11111111-1111-1111-1111-111111111111', [
      'ownership_authority',
      'condition_accuracy',
    ])
    expect(hash).toBe('8650ff761bad4ce69a87793f70c8c0bd')
  })

  it('produces the same hash for identical repeated inputs (retry detection)', () => {
    const a = computeSubmitRequestHash('listing-1', ['ownership_authority', 'platform_terms'])
    const b = computeSubmitRequestHash('listing-1', ['ownership_authority', 'platform_terms'])
    expect(a).toBe(b)
  })

  it('produces a different hash for a different listing id', () => {
    const a = computeSubmitRequestHash('listing-1', ['ownership_authority'])
    const b = computeSubmitRequestHash('listing-2', ['ownership_authority'])
    expect(a).not.toBe(b)
  })

  it('produces a different hash for a different declaration set', () => {
    const a = computeSubmitRequestHash('listing-1', ['ownership_authority'])
    const b = computeSubmitRequestHash('listing-1', ['ownership_authority', 'platform_terms'])
    expect(a).not.toBe(b)
  })

  it('produces a different hash when declaration order differs, matching Postgres array-to-text semantics', () => {
    const a = computeSubmitRequestHash('listing-1', ['ownership_authority', 'platform_terms'])
    const b = computeSubmitRequestHash('listing-1', ['platform_terms', 'ownership_authority'])
    expect(a).not.toBe(b)
  })
})
