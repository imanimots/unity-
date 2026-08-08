import { applyBps } from '@/lib/money/basis-points'
import type { MerchantSubscriptionPlan } from '@/types'

/**
 * Unity's ONE trusted commission FORMULA (Phase 2, Step B). The actual
 * qualifying write happens inside
 * qualify_sale_unity_commission()/qualify_rental_payment_unity_commission()
 * (supabase/migrations/20260823000003_unity_commission_calc_and_qualify_rpcs.sql)
 * via its own SQL twin, _calculate_unity_commission() -- that RPC is
 * what's authoritative for money, matching
 * src/lib/affiliate/commission-calc.ts's own established
 * "non-authoritative mirror, unit-tested in isolation" precedent. This
 * TS copy is used for: unit testing the formula exhaustively (easier
 * than exercising it only through a live RPC), and for admin/merchant
 * UI previews/breakdowns that display what a commission is or would be
 * without needing a round-trip write.
 *
 * Never scattered into a route handler, a booking/order service, a
 * payout service, or a second SQL copy with different digits -- both
 * this file and the SQL function are the only two places the formula
 * exists, and they are required to agree (enforced by the shared
 * boundary-value tests in this file's __tests__ mirroring the SQL
 * regression script's own boundary checks).
 *
 * Plan/rates are never client-suppliable -- this function only ever
 * accepts a server-resolved MerchantSubscriptionPlan (from Phase 1's
 * getEffectiveMerchantPlan()), never a rate/plan id from a request body.
 */

export const HIGH_VALUE_THRESHOLD_CENTS = 100_000_00 // R100,000.00 -- Rule 2, sale-only
export const HIGH_VALUE_EXCESS_RATE_BPS = 100 // exactly 1.00%, REPLACES (never adds to) the plan rate on the amount above the threshold
export const UNITY_COMMISSION_CALCULATION_VERSION = 1 // bumped only if the formula itself ever changes -- "unity_commission_v1"

export type CommissionTransactionKind = 'sale' | 'rental'

export interface CalculateUnityCommissionInput {
  transactionKind: CommissionTransactionKind
  /** The final eligible base, already net of every excluded amount (delivery, deposit, insurance, etc.) -- see Rule 1/3/5. Integer cents. */
  eligibleBaseCents: number
  currency: string
  /** Server-resolved via Phase 1's getEffectiveMerchantPlan() at the qualifying event's own timestamp -- never the plan "as of now". */
  plan: Pick<MerchantSubscriptionPlan, 'id' | 'commercial_version' | 'sales_commission_bps' | 'rental_commission_bps'>
}

export interface CalculateUnityCommissionResult {
  transactionKind: CommissionTransactionKind
  eligibleBaseCents: number
  currency: string
  planId: string
  planCommercialVersion: number
  standardRateBps: number
  standardRateBaseCents: number
  excessRateBps: number
  excessBaseCents: number
  commissionCents: number
  calculationVersion: number
}

/**
 * Rule 2 (high-value sales), stated precisely: the normal plan rate
 * applies only to the first R100,000 of the eligible base; exactly 1%
 * applies only to the amount strictly above R100,000, replacing (never
 * added to) the plan rate on that excess portion. Rentals never have an
 * excess portion -- Rule 2 is stated for sales only.
 *
 * "Up to and including R100,000" means the threshold itself still gets
 * the plan rate, not the excess rate -- excessBaseCents is 0 at exactly
 * R100,000.00 and only becomes positive strictly above it.
 */
export function calculateUnityCommission(input: CalculateUnityCommissionInput): CalculateUnityCommissionResult {
  const { transactionKind, eligibleBaseCents, currency, plan } = input

  const standardRateBps = transactionKind === 'sale' ? plan.sales_commission_bps : plan.rental_commission_bps

  const standardRateBaseCents = transactionKind === 'sale' ? Math.min(eligibleBaseCents, HIGH_VALUE_THRESHOLD_CENTS) : eligibleBaseCents
  const excessBaseCents = transactionKind === 'sale' ? Math.max(eligibleBaseCents - HIGH_VALUE_THRESHOLD_CENTS, 0) : 0
  const excessRateBps = excessBaseCents > 0 ? HIGH_VALUE_EXCESS_RATE_BPS : 0

  const standardPortionCents = applyBps(standardRateBaseCents, standardRateBps)
  const excessPortionCents = applyBps(excessBaseCents, excessRateBps)

  return {
    transactionKind,
    eligibleBaseCents,
    currency,
    planId: plan.id,
    planCommercialVersion: plan.commercial_version,
    standardRateBps,
    standardRateBaseCents,
    excessRateBps,
    excessBaseCents,
    commissionCents: standardPortionCents + excessPortionCents,
    calculationVersion: UNITY_COMMISSION_CALCULATION_VERSION,
  }
}

/** Rands (2dp, as stored in payments/orders/bookings) -> integer cents, matching every other money boundary in this codebase. */
export function randsToCents(rands: number): number {
  return Math.round(rands * 100)
}

/** Integer cents -> rands (2dp) for display or storage back into a numeric(12,2) column. */
export function centsToRands(cents: number): number {
  return cents / 100
}
