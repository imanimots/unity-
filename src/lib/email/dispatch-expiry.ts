import type { SupabaseClient } from '@supabase/supabase-js'
import { sendTemplate } from './service'
import { loadBookingEmailContext } from './context'

/**
 * Called by src/lib/bookings/lazy-expiry.ts right after
 * expire_unpaid_accepted_bookings() returns the ids it just transitioned
 * (Step 8 extended that RPC's return shape specifically to enable this --
 * see the migration). Sends the booking.payment_expired email to both
 * renter and merchant for each newly-expired booking, never for a booking
 * that was already expired before this sweep (the RPC only ever returns
 * ids it transitioned in that exact call, so a repeated sweep naturally
 * returns an empty list and this function is a no-op).
 */
export async function dispatchPaymentExpiredEmails(admin: SupabaseClient, expiredBookingIds: string[]): Promise<void> {
  for (const bookingId of expiredBookingIds) {
    const ctx = await loadBookingEmailContext(admin, bookingId)
    if (!ctx) continue

    await sendTemplate(admin, {
      eventType: 'booking.payment_expired',
      templateId: 'booking-payment-expired-renter',
      recipientUserId: ctx.renterId,
      relatedEntityType: 'booking',
      relatedEntityId: ctx.bookingId,
      vars: { renterName: ctx.renterName, listingTitle: ctx.listingTitle, bookingReference: ctx.bookingReference },
    })

    await sendTemplate(admin, {
      eventType: 'booking.payment_expired',
      templateId: 'booking-payment-expired-merchant',
      recipientUserId: ctx.merchantId,
      relatedEntityType: 'booking',
      relatedEntityId: ctx.bookingId,
      vars: { merchantName: ctx.merchantName, listingTitle: ctx.listingTitle, bookingReference: ctx.bookingReference },
    })
  }
}
