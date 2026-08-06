/**
 * Non-authoritative mirror of the commission formula computed inside
 * qualify_sale_affiliate_commission()/qualify_rental_payment_affiliate_
 * commission() (supabase/migrations/20260819000008_affiliate_rpcs.sql).
 * The RPC is what actually enforces this -- this exists for unit
 * testing the formula in isolation, matching src/lib/payments/
 * state-machine.ts's own "unit-tested, non-authoritative" precedent.
 *
 * Always numeric, never floating-point-sensitive: JS `number` is fine
 * here specifically because every input/output is rounded to exact
 * cents before use, matching the RPC's own numeric(12,2)/numeric(5,2)
 * columns.
 */
export function calculateEligibleSaleBase(totalAmount: number, shippingFee: number): number {
  return Math.max(round2(totalAmount - shippingFee), 0)
}

export function calculateCommissionAmount(eligibleBase: number, commissionRatePercent: number): number {
  return round2(eligibleBase * commissionRatePercent / 100)
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}
