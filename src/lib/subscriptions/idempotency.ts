import { createHash } from 'crypto'
import { checkIdempotentReplay } from '@/lib/bookings/idempotency'
export { checkIdempotentReplay }

/**
 * Mirrors each subscription RPC's request_hash formula exactly
 * (supabase/migrations/20260822000003_merchant_subscription_rpcs.sql).
 */

function md5(input: string): string {
  return createHash('md5').update(input).digest('hex')
}

export function computeRequestPlanChangeHash(merchantId: string, targetPlanId: string, billingReference: string | null | undefined): string {
  return md5(`${merchantId}|${targetPlanId}|${billingReference ?? ''}`)
}

export function computeCancelPendingChangeHash(merchantId: string): string {
  return md5(merchantId)
}

export function computeAdminCorrectHash(merchantId: string, newPlanId: string, immediate: boolean): string {
  return md5(`${merchantId}|${newPlanId}|${immediate}`)
}
