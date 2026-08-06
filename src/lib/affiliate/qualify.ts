import type { SupabaseClient } from '@supabase/supabase-js'
import { computeQualifyCommissionHash } from './idempotency'

/**
 * Best-effort wrappers around the two qualification RPCs, called from
 * the orchestrator layer (chargeOrderPayment()/authorizeBookingFinancials())
 * right after a payment reaches 'captured'. Never throws -- an affiliate
 * qualification failure must never roll back or fail the underlying
 * customer payment (Part J). A failure here is simply logged; the
 * exceptions queue's "successful eligible payment missing commission"
 * category (computed live from table state) is what surfaces it to an
 * admin, not a value returned from these functions.
 *
 * Safe to call on every capture, including an idempotent replay of an
 * already-captured payment -- qualify_*_affiliate_commission() is
 * itself idempotent (unique(payment_id) at the database level), so a
 * repeat call is a fast, harmless no-op. This also covers the case
 * where a prior call captured the payment but crashed before reaching
 * qualification -- a later replay still gets the commission created.
 */
export async function qualifySaleAffiliateCommission(admin: SupabaseClient, orderId: string, paymentId: string): Promise<void> {
  try {
    const { error } = await admin.rpc('qualify_sale_affiliate_commission', {
      p_order_id: orderId,
      p_payment_id: paymentId,
      p_idempotency_key: computeQualifyCommissionHash(orderId, paymentId),
    })
    if (error) {
      console.error('[affiliate.qualify] sale qualification RPC error', { orderId, paymentId, error: error.message })
    }
  } catch (err) {
    console.error('[affiliate.qualify] sale qualification unexpected error', { orderId, paymentId, err })
  }
}

export async function qualifyRentalPaymentAffiliateCommission(admin: SupabaseClient, bookingId: string, paymentId: string): Promise<void> {
  try {
    const { error } = await admin.rpc('qualify_rental_payment_affiliate_commission', {
      p_booking_id: bookingId,
      p_payment_id: paymentId,
      p_idempotency_key: computeQualifyCommissionHash(bookingId, paymentId),
    })
    if (error) {
      console.error('[affiliate.qualify] rental qualification RPC error', { bookingId, paymentId, error: error.message })
    }
  } catch (err) {
    console.error('[affiliate.qualify] rental qualification unexpected error', { bookingId, paymentId, err })
  }
}
