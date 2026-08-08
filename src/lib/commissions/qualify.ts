import type { SupabaseClient } from '@supabase/supabase-js'
import { computeQualifyCommissionHash } from './idempotency'

/**
 * Best-effort wrappers around the two Unity commission qualification
 * RPCs, called from the orchestrator layer (chargeOrderPayment()/
 * authorizeBookingFinancials()) right after a payment reaches
 * 'captured' -- the exact same hook points already used for
 * qualifySaleAffiliateCommission()/qualifyRentalPaymentAffiliateCommission()
 * (src/lib/affiliate/qualify.ts), called independently and
 * additionally, never merged into the affiliate functions. Never
 * throws -- a Unity commission qualification failure must never roll
 * back or fail the underlying customer payment. A failure here is
 * simply logged; the admin exceptions queue is what surfaces it.
 *
 * Safe to call on every capture, including an idempotent replay of an
 * already-captured payment -- qualify_*_unity_commission() is itself
 * idempotent (unique(payment_id) at the database level).
 */
export async function qualifySaleUnityCommission(admin: SupabaseClient, orderId: string, paymentId: string): Promise<void> {
  try {
    const { error } = await admin.rpc('qualify_sale_unity_commission', {
      p_order_id: orderId,
      p_payment_id: paymentId,
      p_idempotency_key: computeQualifyCommissionHash(orderId, paymentId),
    })
    if (error) {
      console.error('[commissions.qualify] sale qualification RPC error', { orderId, paymentId, error: error.message })
    }
  } catch (err) {
    console.error('[commissions.qualify] sale qualification unexpected error', { orderId, paymentId, err })
  }
}

export async function qualifyRentalPaymentUnityCommission(admin: SupabaseClient, bookingId: string, paymentId: string): Promise<void> {
  try {
    const { error } = await admin.rpc('qualify_rental_payment_unity_commission', {
      p_booking_id: bookingId,
      p_payment_id: paymentId,
      p_idempotency_key: computeQualifyCommissionHash(bookingId, paymentId),
    })
    if (error) {
      console.error('[commissions.qualify] rental qualification RPC error', { bookingId, paymentId, error: error.message })
    }
  } catch (err) {
    console.error('[commissions.qualify] rental qualification unexpected error', { bookingId, paymentId, err })
  }
}
