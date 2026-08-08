/**
 * Booking price preview -- mirrors create_booking_request()'s formula
 * exactly (supabase/migrations/20260731000002_booking_weekly_rate_alignment.sql)
 * so the renter-facing form shows an accurate estimate before submitting.
 * This is NOT the authoritative calculation -- the RPC recomputes the
 * financial snapshot independently, server-side, from the listing's
 * current state at request time. This module exists only so the browser
 * isn't guessing at a different number than what the server will store.
 *
 * Rounding rule: duration is billed in whole days, rounding UP for any
 * partial day (a booking from 10:00 Monday to 10:00 Tuesday is 1 day; one
 * that runs to 11:00 Tuesday is 2 days).
 *
 * Rate model: matches src/components/listings/booking-card.tsx's existing
 * rule exactly -- the weekly rate applies, expressed as an effective
 * per-day rate, once duration reaches 7+ days and the listing has one set;
 * otherwise the daily rate applies. weekend_rate and monthly_rate exist as
 * columns on listings but are not reachable from the wizard's validation
 * schema or from save_listing_draft() -- audited across the whole repo,
 * zero UI/validation/RPC references -- so no merchant can ever actually
 * set them today. Not implemented here either; see
 * docs/BOOKING_LIFECYCLE.md.
 */

export interface BookingPriceInput {
  dailyRate: number
  weeklyRate?: number | null
  depositRequired: boolean
  depositAmount: number | null | undefined
  startAt: Date
  endAt: Date
}

export interface BookingPriceBreakdown {
  durationDays: number
  rateAmount: number
  rateUnit: 'daily' | 'weekly'
  subtotalAmount: number
  depositAmount: number
  platformFeeAmount: number
  renterTotalAmount: number
  merchantProceedsEstimate: number
  currency: 'ZAR'
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

export function calculateBookingPrice(input: BookingPriceInput): BookingPriceBreakdown {
  if (!(input.startAt instanceof Date) || !(input.endAt instanceof Date) || Number.isNaN(input.startAt.getTime()) || Number.isNaN(input.endAt.getTime())) {
    throw new Error('Invalid start or end date')
  }
  if (input.startAt >= input.endAt) {
    throw new Error('End time must be after start time')
  }
  if (!(input.dailyRate > 0)) {
    throw new Error('Invalid daily rate')
  }

  const durationDays = Math.ceil((input.endAt.getTime() - input.startAt.getTime()) / MS_PER_DAY)

  let rateUnit: 'daily' | 'weekly'
  let rateAmount: number
  let subtotalAmount: number
  if (durationDays >= 7 && input.weeklyRate) {
    rateUnit = 'weekly'
    rateAmount = round2(input.weeklyRate / 7)
    subtotalAmount = round2((input.weeklyRate / 7) * durationDays)
  } else {
    rateUnit = 'daily'
    rateAmount = input.dailyRate
    subtotalAmount = round2(input.dailyRate * durationDays)
  }

  const depositAmount = input.depositRequired ? round2(input.depositAmount ?? 0) : 0
  // Deliberately always 0, and must stay that way -- Unity Phase 2's
  // commission engine (src/lib/commissions/calculate.ts) is
  // merchant-funded (Rule 1: "the buyer/renter does NOT pay Unity's
  // commission as an additional percentage"), computed only at
  // rental_charge capture via qualify_rental_payment_unity_commission(),
  // and never added to what the renter is quoted or charged here. This
  // field exists only because renterTotalAmount's formula has a slot
  // for it; repurposing it to carry Unity's commission would put a
  // customer-facing Unity commission surcharge directly into checkout,
  // which Phase 2 explicitly prohibits (Step J).
  const platformFeeAmount = 0
  const renterTotalAmount = round2(subtotalAmount + depositAmount + platformFeeAmount)
  const merchantProceedsEstimate = round2(subtotalAmount - platformFeeAmount)

  return {
    durationDays,
    rateAmount,
    rateUnit,
    subtotalAmount,
    depositAmount,
    platformFeeAmount,
    renterTotalAmount,
    merchantProceedsEstimate,
    currency: 'ZAR',
  }
}

// Exact-cents rounding -- avoids raw floating-point display drift (e.g.
// 250.1 * 3 producing 750.30000000000001). Still display-only; the
// server's numeric(12,2) columns are the actual exact representation.
function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}
