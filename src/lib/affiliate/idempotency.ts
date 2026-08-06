import { createHash } from 'crypto'
import { checkIdempotentReplay } from '@/lib/bookings/idempotency'
export { checkIdempotentReplay }

/**
 * Mirrors each affiliate RPC's request_hash formula exactly
 * (supabase/migrations/20260819000008_affiliate_rpcs.sql). Reuses
 * checkIdempotentReplay() directly -- already fully generic.
 */

function md5(input: string): string {
  return createHash('md5').update(input).digest('hex')
}

export function computeOpenAttributionHash(listingId: string, referralCode: string): string {
  return md5(`${listingId}|${referralCode}`)
}

export function computeQualifyCommissionHash(transactionId: string, paymentId: string): string {
  return md5(`${transactionId}|${paymentId}`)
}

export function computeCommissionIdOnlyHash(commissionId: string): string {
  return md5(commissionId)
}

/**
 * Mirrors hold_affiliate_commission / void_affiliate_commission /
 * mark_affiliate_commission_paid_manually / retry_affiliate_payout's
 * shared `commission_id|reason` request_hash formula -- these RPCs all
 * require and hash a mandatory reason, unlike release_affiliate_
 * commission_hold (no reason param, correctly uses
 * computeCommissionIdOnlyHash alone). Using the reason-less hash for a
 * reason-taking operation was a real bug found during Step 11 Phase 7
 * live regression testing: the route's own pre-check hash never matched
 * what the RPC actually stored, so a legitimate exact replay was always
 * misreported as a conflicting request.
 */
export function computeCommissionIdAndReasonHash(commissionId: string, reason: string): string {
  return md5(`${commissionId}|${reason}`)
}

export function computeAdjustmentHash(commissionId: string, amount: number, reason: string): string {
  return md5(`${commissionId}|${amount}|${reason}`)
}
