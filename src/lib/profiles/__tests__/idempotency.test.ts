import { describe, it, expect } from 'vitest'
import { computeReportProfileHash } from '../idempotency'

const REPORTED_ID = '11111111-1111-1111-8111-111111111111'

describe('computeReportProfileHash', () => {
  it('matches the exact md5 Postgres produces for the same inputs', () => {
    // select md5(reported_profile_id::text || '|' || reason || '|' || coalesce(description, ''))
    expect(computeReportProfileHash(REPORTED_ID, 'spam', 'test description')).toBe('54406866def7f0aa859fd5ac6288b134')
  })

  it('treats a missing description the same as an empty string', () => {
    expect(computeReportProfileHash(REPORTED_ID, 'spam', undefined)).toBe('407ac29ddb57873839bddd71be51ce58')
    expect(computeReportProfileHash(REPORTED_ID, 'spam', null)).toBe('407ac29ddb57873839bddd71be51ce58')
  })

  it('produces a different hash for a different reason', () => {
    expect(computeReportProfileHash(REPORTED_ID, 'spam', null)).not.toBe(computeReportProfileHash(REPORTED_ID, 'harassment', null))
  })
})
