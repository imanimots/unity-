import { createHash } from 'crypto'
import { checkIdempotentReplay } from '@/lib/bookings/idempotency'
export { checkIdempotentReplay }

/**
 * Mirrors each order RPC's request_hash formula exactly
 * (supabase/migrations/20260812000004_order_rpcs.sql /
 * 20260812000002_order_payments_widening.sql). Reuses
 * checkIdempotentReplay() directly from src/lib/bookings/idempotency.ts
 * -- it's already fully generic, no relocation needed.
 */

function md5(input: string): string {
  return createHash('md5').update(input).digest('hex')
}

export function computeCreateOrderHash(listingId: string, quantity: number): string {
  return md5(`${listingId}|${quantity}`)
}

export function computeCreateOrderPaymentIntentHash(orderId: string, amount: number, currency: string, provider: string): string {
  return md5(`${orderId}|${amount}|${currency}|${provider}`)
}

export function computeMarkOrderPaidHash(orderId: string, paymentId: string | null | undefined): string {
  return md5(`${orderId}|${paymentId ?? ''}`)
}

export function computeOrderIdOnlyHash(orderId: string): string {
  return md5(orderId)
}

export function computeCancelOrderHash(orderId: string, cancellationReason: string | null | undefined): string {
  return md5(`${orderId}|${cancellationReason ?? ''}`)
}
