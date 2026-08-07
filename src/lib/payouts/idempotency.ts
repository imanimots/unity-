import { createHash } from 'crypto'
import { checkIdempotentReplay } from '@/lib/bookings/idempotency'
export { checkIdempotentReplay }

/**
 * Mirrors each merchant payout RPC's request_hash formula exactly
 * (supabase/migrations/20260820000003_merchant_payout_rpcs.sql).
 */

function md5(input: string): string {
  return createHash('md5').update(input).digest('hex')
}

export function computeMarkProcessingHash(payoutId: string, reason: string | null | undefined): string {
  return md5(`${payoutId}|${reason ?? ''}`)
}

export function computeRetryPayoutHash(payoutId: string, reason: string): string {
  return md5(`${payoutId}|${reason}`)
}

export function computeMarkPaidHash(payoutId: string, payoutReference: string, payoutMethod: string): string {
  return md5(`${payoutId}|${payoutReference}|${payoutMethod}`)
}

export function computeMarkFailedHash(payoutId: string, failureCategory: string, reason: string): string {
  return md5(`${payoutId}|${failureCategory}|${reason}`)
}
