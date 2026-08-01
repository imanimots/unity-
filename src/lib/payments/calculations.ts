/**
 * Pure financial calculations mirroring the guards inside create_refund()
 * and transition_payment_status()
 * (supabase/migrations/20260801000004_payment_rpcs.sql). The RPCs remain
 * authoritative -- these exist so the same rules are independently unit
 * testable and so a trusted route can validate before ever calling the
 * RPC, for a clearer error message.
 */

// Matches the rate already documented in
// src/app/(dashboard)/dashboard/merchant/payouts/page.tsx ("Unity
// charges a 5% platform fee on each completed rental"). Not yet
// configurable per merchant/listing -- a flat rate is the whole of what
// the platform currently documents anywhere.
export const PLATFORM_FEE_RATE = 0.05

export function calculatePlatformFee(rentalAmount: number): number {
  if (rentalAmount < 0) throw new Error('Invalid rental amount')
  return round2(rentalAmount * PLATFORM_FEE_RATE)
}

export function calculateMerchantProceeds(rentalAmount: number): number {
  return round2(rentalAmount - calculatePlatformFee(rentalAmount))
}

/**
 * Mirrors create_refund()'s guard exactly: the sum of all non-failed
 * refunds already recorded against a payment, plus the new refund
 * amount, may never exceed the payment's own amount.
 */
export function calculateRefundableAmount(paymentAmount: number, alreadyRefunded: number): number {
  return Math.max(0, round2(paymentAmount - alreadyRefunded))
}

export function isRefundAmountValid(paymentAmount: number, alreadyRefunded: number, requestedAmount: number): boolean {
  if (requestedAmount <= 0) return false
  return alreadyRefunded + requestedAmount <= paymentAmount
}

/**
 * Deposit release logic: an authorised deposit is either fully released
 * back to the renter (no damage/loss claim) or captured, in full or in
 * part, against a claim. This mirrors the same "can't exceed what's
 * available" shape as a refund, applied to a deposit's own amount.
 */
export function calculateDepositCaptureAmount(depositAmount: number, claimedAmount: number): number {
  if (claimedAmount < 0) throw new Error('Invalid claimed amount')
  return Math.min(depositAmount, round2(claimedAmount))
}

export function calculateDepositReleaseAmount(depositAmount: number, capturedAmount: number): number {
  return Math.max(0, round2(depositAmount - capturedAmount))
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}
