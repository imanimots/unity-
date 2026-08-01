import { describe, it, expect } from 'vitest'
import { calculateBookingPrice } from '../price'

describe('calculateBookingPrice', () => {
  it('bills exactly 1 day for a 24-hour booking with no partial-day remainder', () => {
    const result = calculateBookingPrice({
      dailyRate: 250,
      depositRequired: false,
      depositAmount: null,
      startAt: new Date('2026-08-01T10:00:00Z'),
      endAt: new Date('2026-08-02T10:00:00Z'),
    })
    expect(result.durationDays).toBe(1)
    expect(result.subtotalAmount).toBe(250)
    expect(result.rateUnit).toBe('daily')
    expect(result.rateAmount).toBe(250)
  })

  it('rounds a partial extra day up to a full day', () => {
    const result = calculateBookingPrice({
      dailyRate: 250,
      depositRequired: false,
      depositAmount: null,
      startAt: new Date('2026-08-01T10:00:00Z'),
      endAt: new Date('2026-08-02T11:00:00Z'), // 25 hours -> rounds up to 2 days
    })
    expect(result.durationDays).toBe(2)
    expect(result.subtotalAmount).toBe(500)
  })

  it('includes the deposit when required', () => {
    const result = calculateBookingPrice({
      dailyRate: 250,
      depositRequired: true,
      depositAmount: 500,
      startAt: new Date('2026-08-01T10:00:00Z'),
      endAt: new Date('2026-08-02T10:00:00Z'),
    })
    expect(result.depositAmount).toBe(500)
    expect(result.renterTotalAmount).toBe(750)
  })

  it('treats deposit as zero when not required, even if an amount is set on the listing', () => {
    const result = calculateBookingPrice({
      dailyRate: 250,
      depositRequired: false,
      depositAmount: 500,
      startAt: new Date('2026-08-01T10:00:00Z'),
      endAt: new Date('2026-08-02T10:00:00Z'),
    })
    expect(result.depositAmount).toBe(0)
    expect(result.renterTotalAmount).toBe(250)
  })

  it('computes merchant proceeds as subtotal minus platform fee (currently always 0)', () => {
    const result = calculateBookingPrice({
      dailyRate: 250,
      depositRequired: false,
      depositAmount: null,
      startAt: new Date('2026-08-01T10:00:00Z'),
      endAt: new Date('2026-08-04T10:00:00Z'),
    })
    expect(result.platformFeeAmount).toBe(0)
    expect(result.merchantProceedsEstimate).toBe(result.subtotalAmount)
  })

  it('avoids floating-point drift for a rate that does not divide evenly', () => {
    const result = calculateBookingPrice({
      dailyRate: 133.33,
      depositRequired: false,
      depositAmount: null,
      startAt: new Date('2026-08-01T00:00:00Z'),
      endAt: new Date('2026-08-04T00:00:00Z'), // 3 days
    })
    expect(result.subtotalAmount).toBe(399.99)
  })

  it('rejects a range where start is not before end', () => {
    expect(() =>
      calculateBookingPrice({
        dailyRate: 250,
        depositRequired: false,
        depositAmount: null,
        startAt: new Date('2026-08-02T10:00:00Z'),
        endAt: new Date('2026-08-01T10:00:00Z'),
      })
    ).toThrow('End time must be after start time')
  })

  it('rejects an equal start and end', () => {
    const t = new Date('2026-08-01T10:00:00Z')
    expect(() =>
      calculateBookingPrice({ dailyRate: 250, depositRequired: false, depositAmount: null, startAt: t, endAt: t })
    ).toThrow('End time must be after start time')
  })

  it('rejects a zero or negative daily rate', () => {
    expect(() =>
      calculateBookingPrice({
        dailyRate: 0,
        depositRequired: false,
        depositAmount: null,
        startAt: new Date('2026-08-01T10:00:00Z'),
        endAt: new Date('2026-08-02T10:00:00Z'),
      })
    ).toThrow('Invalid daily rate')
  })

  it('rejects an invalid date', () => {
    expect(() =>
      calculateBookingPrice({
        dailyRate: 250,
        depositRequired: false,
        depositAmount: null,
        startAt: new Date('not-a-date'),
        endAt: new Date('2026-08-02T10:00:00Z'),
      })
    ).toThrow('Invalid start or end date')
  })
})

// Matches src/components/listings/booking-card.tsx's existing rule exactly:
// `days >= 7 && listing.weekly_rate ? listing.weekly_rate / 7 : listing.daily_rate`
describe('calculateBookingPrice — weekly rate blending', () => {
  it('uses the daily rate for a 6-day booking even when a weekly rate is set', () => {
    const result = calculateBookingPrice({
      dailyRate: 250,
      weeklyRate: 1400,
      depositRequired: false,
      depositAmount: null,
      startAt: new Date('2026-08-01T00:00:00Z'),
      endAt: new Date('2026-08-07T00:00:00Z'), // 6 days
    })
    expect(result.durationDays).toBe(6)
    expect(result.rateUnit).toBe('daily')
    expect(result.subtotalAmount).toBe(1500)
  })

  it('switches to the weekly rate at exactly 7 days', () => {
    const result = calculateBookingPrice({
      dailyRate: 250,
      weeklyRate: 1400,
      depositRequired: false,
      depositAmount: null,
      startAt: new Date('2026-08-01T00:00:00Z'),
      endAt: new Date('2026-08-08T00:00:00Z'), // 7 days
    })
    expect(result.durationDays).toBe(7)
    expect(result.rateUnit).toBe('weekly')
    expect(result.rateAmount).toBe(200) // 1400 / 7
    expect(result.subtotalAmount).toBe(1400)
  })

  it('applies the weekly rate for a longer duration too (14 days)', () => {
    const result = calculateBookingPrice({
      dailyRate: 250,
      weeklyRate: 1400,
      depositRequired: false,
      depositAmount: null,
      startAt: new Date('2026-08-01T00:00:00Z'),
      endAt: new Date('2026-08-15T00:00:00Z'), // 14 days
    })
    expect(result.rateUnit).toBe('weekly')
    expect(result.subtotalAmount).toBe(2800) // (1400/7) * 14
  })

  it('falls back to the daily rate when no weekly rate is set, regardless of duration', () => {
    const result = calculateBookingPrice({
      dailyRate: 250,
      weeklyRate: null,
      depositRequired: false,
      depositAmount: null,
      startAt: new Date('2026-08-01T00:00:00Z'),
      endAt: new Date('2026-08-15T00:00:00Z'), // 14 days
    })
    expect(result.rateUnit).toBe('daily')
    expect(result.subtotalAmount).toBe(3500) // 250 * 14
  })

  it('rounds a non-evenly-divisible weekly rate to exact cents', () => {
    // 1000 / 7 = 142.857142... -> per-day rate rounds to 142.86,
    // but the subtotal is computed from the unrounded rate then rounded,
    // matching booking-card.tsx's own round-the-total (not round-then-multiply) approach
    const result = calculateBookingPrice({
      dailyRate: 200,
      weeklyRate: 1000,
      depositRequired: false,
      depositAmount: null,
      startAt: new Date('2026-08-01T00:00:00Z'),
      endAt: new Date('2026-08-08T00:00:00Z'), // 7 days
    })
    expect(result.rateAmount).toBe(142.86)
    expect(result.subtotalAmount).toBe(1000) // (1000/7)*7 == 1000 exactly, no residual drift
  })

  it('handles a leap-year February span correctly (2028 is a leap year)', () => {
    const result = calculateBookingPrice({
      dailyRate: 100,
      depositRequired: false,
      depositAmount: null,
      startAt: new Date('2028-02-28T00:00:00Z'),
      endAt: new Date('2028-03-01T00:00:00Z'), // Feb 29 exists in 2028 -> 2 days, not 1
    })
    expect(result.durationDays).toBe(2)
    expect(result.subtotalAmount).toBe(200)
  })

  it('computes duration from UTC instants, unaffected by any local-timezone DST transition', () => {
    // South Africa observes no DST, but this asserts the calculator itself
    // is DST-agnostic: it operates purely on epoch milliseconds via
    // Date#getTime(), never on local wall-clock calendar arithmetic.
    const result = calculateBookingPrice({
      dailyRate: 100,
      depositRequired: false,
      depositAmount: null,
      startAt: new Date('2026-03-08T00:00:00Z'), // a US DST-transition date -- irrelevant here
      endAt: new Date('2026-03-09T00:00:00Z'),
    })
    expect(result.durationDays).toBe(1)
    expect(result.subtotalAmount).toBe(100)
  })
})
