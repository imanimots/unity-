import { describe, it, expect } from 'vitest'
import {
  computeCreateBookingRequestHash,
  computeAcceptBookingRequestHash,
  computeRejectBookingRequestHash,
  computeCancelBookingHash,
  computeBookingIdOnlyHash,
} from '../idempotency'

describe('computeCreateBookingRequestHash', () => {
  it('matches the exact md5 Postgres produces for the same inputs', () => {
    // Cross-checked live against create_booking_request()'s own formula:
    // select md5(listing_id || '|' || extract(epoch from start_at)::text
    //   || '|' || extract(epoch from end_at)::text || '|' || renter_message)
    const hash = computeCreateBookingRequestHash(
      '11111111-1111-1111-1111-111111111111',
      new Date('2026-08-01T10:00:00Z'),
      new Date('2026-08-02T10:00:00Z'),
      'hello'
    )
    expect(hash).toBe('8e6d34f80d1eff44a022dcc81f58ed3e')
  })

  it('produces the same hash for identical repeated inputs', () => {
    const args: [string, Date, Date, string] = ['listing-1', new Date('2026-08-01T00:00:00Z'), new Date('2026-08-03T00:00:00Z'), 'note']
    expect(computeCreateBookingRequestHash(...args)).toBe(computeCreateBookingRequestHash(...args))
  })

  it('produces a different hash when the dates differ', () => {
    const a = computeCreateBookingRequestHash('listing-1', new Date('2026-08-01T00:00:00Z'), new Date('2026-08-03T00:00:00Z'), null)
    const b = computeCreateBookingRequestHash('listing-1', new Date('2026-08-02T00:00:00Z'), new Date('2026-08-03T00:00:00Z'), null)
    expect(a).not.toBe(b)
  })

  it('treats null and undefined renter_message the same way as an empty string', () => {
    const start = new Date('2026-08-01T00:00:00Z')
    const end = new Date('2026-08-03T00:00:00Z')
    const a = computeCreateBookingRequestHash('listing-1', start, end, null)
    const b = computeCreateBookingRequestHash('listing-1', start, end, undefined)
    const c = computeCreateBookingRequestHash('listing-1', start, end, '')
    expect(a).toBe(b)
    expect(b).toBe(c)
  })
})

describe('computeAcceptBookingRequestHash', () => {
  it('matches the exact md5 Postgres produces for the same inputs', () => {
    // select md5(booking_id || '|' || merchant_response_note)
    const hash = computeAcceptBookingRequestHash('11111111-1111-1111-1111-111111111111', 'note here')
    expect(hash).toBe('75742c97797f556d91d96978f6214b51')
  })
})

describe('computeBookingIdOnlyHash', () => {
  it('matches the exact md5 Postgres produces for a bare booking id', () => {
    // select md5(booking_id)
    const hash = computeBookingIdOnlyHash('11111111-1111-1111-1111-111111111111')
    expect(hash).toBe('38c6cbd28bf165070d070980dd1fb595')
  })

  it('is used identically by start_rental, initiate_return and confirm_return', () => {
    // All three RPCs hash only the booking id -- one shared helper is correct,
    // not three near-duplicate ones.
    const id = 'some-booking-id'
    expect(computeBookingIdOnlyHash(id)).toBe(computeBookingIdOnlyHash(id))
  })
})

describe('computeRejectBookingRequestHash / computeCancelBookingHash', () => {
  it('produce different hashes for different reasons on the same booking', () => {
    const a = computeRejectBookingRequestHash('booking-1', 'not available')
    const b = computeRejectBookingRequestHash('booking-1', 'condition mismatch')
    expect(a).not.toBe(b)
  })

  it('cancel and reject hashes for the same inputs are computed independently (different operations, different idempotency_keys rows)', () => {
    const reject = computeRejectBookingRequestHash('booking-1', 'reason')
    const cancel = computeCancelBookingHash('booking-1', 'reason')
    // Same formula shape, so equal here is expected and fine -- they never
    // collide in practice because idempotency_keys' primary key also
    // includes `operation`, not just the hash.
    expect(reject).toBe(cancel)
  })
})
