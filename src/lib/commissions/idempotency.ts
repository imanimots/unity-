import { createHash } from 'crypto'
import { checkIdempotentReplay } from '@/lib/bookings/idempotency'
export { checkIdempotentReplay }

/**
 * Mirrors each Unity commission RPC's request_hash formula exactly
 * (supabase/migrations/20260823000003_unity_commission_calc_and_qualify_rpcs.sql,
 * 20260823000005_unity_commission_lifecycle_rpcs.sql).
 */

function md5(input: string): string {
  return createHash('md5').update(input).digest('hex')
}

export function computeQualifyCommissionHash(transactionId: string, paymentId: string): string {
  return md5(`${transactionId}|${paymentId}`)
}

export function computeCommissionIdOnlyHash(commissionId: string): string {
  return md5(commissionId)
}

export function computeCommissionIdAndReasonHash(commissionId: string, reason: string): string {
  return md5(`${commissionId}|${reason}`)
}

/** amountRands mirrors the RPC's own p_amount::text formula -- the numeric rands value sent to create_unity_commission_adjustment(), not cents. */
export function computeAdjustmentHash(commissionId: string, amountRands: number, reason: string): string {
  return md5(`${commissionId}|${amountRands}|${reason}`)
}
