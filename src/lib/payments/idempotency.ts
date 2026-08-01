import { createHash } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { PaymentStatus } from './state-machine'

/**
 * Mirrors each payment RPC's request_hash formula exactly
 * (supabase/migrations/20260801000004_payment_rpcs.sql), the same
 * pattern already proven for listings and bookings -- see
 * src/lib/bookings/idempotency.ts. Each formula below was cross-checked
 * live against the actual Postgres md5() output for the same inputs,
 * including verifying that a plain numeric literal's ::text cast never
 * introduces padding a JSON-derived JS number wouldn't also produce.
 */

function md5(input: string): string {
  return createHash('md5').update(input).digest('hex')
}

export function computeCreatePaymentIntentHash(
  bookingId: string,
  paymentType: string,
  amount: number,
  currency: string,
  provider: string
): string {
  return md5(`${bookingId}|${paymentType}|${String(amount)}|${currency}|${provider}`)
}

export function computeTransitionPaymentStatusHash(
  paymentId: string,
  newStatus: PaymentStatus,
  providerReference: string | null | undefined,
  failureReason: string | null | undefined
): string {
  return md5(`${paymentId}|${newStatus}|${providerReference ?? ''}|${failureReason ?? ''}`)
}

export function computeCreateRefundHash(paymentId: string, amount: number, reason: string | null | undefined): string {
  return md5(`${paymentId}|${String(amount)}|${reason ?? ''}`)
}

export function computeCreateMerchantPayoutHash(merchantId: string, bookingId: string, amount: number): string {
  return md5(`${merchantId}|${bookingId}|${String(amount)}`)
}

export type ReplayCheckResult = { status: 'none' } | { status: 'replay'; result: unknown } | { status: 'conflict' }

/** Same replay-check-before-status-check pattern used for bookings and listing submission. */
export async function checkIdempotentReplay(
  admin: SupabaseClient,
  scopingKey: string,
  operation: string,
  idempotencyKey: string | undefined,
  computedHash: string
): Promise<ReplayCheckResult> {
  if (!idempotencyKey) return { status: 'none' }

  const { data } = await admin
    .from('idempotency_keys')
    .select('request_hash, result')
    .eq('merchant_id', scopingKey)
    .eq('operation', operation)
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle()

  if (!data) return { status: 'none' }
  if (data.request_hash !== computedHash) return { status: 'conflict' }
  return { status: 'replay', result: data.result }
}
