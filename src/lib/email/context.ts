import type { SupabaseClient } from '@supabase/supabase-js'

/** Shared display formatting -- keeps every template's vars pre-formatted, plain strings; no template does date/currency math itself. */
export function formatMoney(amount: number | null, currency = 'ZAR'): string {
  if (amount === null) return '—'
  return `${currency === 'ZAR' ? 'R' : currency + ' '}${amount.toFixed(2)}`
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export interface BookingEmailContext {
  bookingId: string
  bookingReference: string
  listingId: string
  listingTitle: string
  renterId: string
  renterName: string
  merchantId: string
  merchantName: string
  startAt: string | null
  endAt: string | null
  paymentDueAt: string | null
  subtotalAmount: number | null
  depositAmount: number | null
  totalAmount: number | null
  currency: string
}

function displayName(profile: { display_name: string | null; full_name: string | null } | null): string {
  return profile?.display_name || profile?.full_name || 'there'
}

/**
 * The one shared query every booking-related email dispatch call site
 * uses to build its vars -- avoids duplicating the bookings+profiles join
 * in every route. Returns null if the booking can't be found (the caller
 * should skip dispatch entirely in that case, never fabricate context).
 */
export async function loadBookingEmailContext(admin: SupabaseClient, bookingId: string): Promise<BookingEmailContext | null> {
  const { data: booking } = await admin
    .from('bookings')
    .select(
      'id, booking_reference, listing_id, renter_id, merchant_id, start_at, end_at, payment_due_at, subtotal_amount, deposit_amount_snapshot, renter_total_amount, currency'
    )
    .eq('id', bookingId)
    .maybeSingle()
  if (!booking) return null

  const [{ data: listing }, { data: renterProfile }, { data: merchantProfile }] = await Promise.all([
    admin.from('listings').select('title').eq('id', booking.listing_id).maybeSingle(),
    admin.from('profiles').select('display_name, full_name').eq('id', booking.renter_id).maybeSingle(),
    admin.from('profiles').select('display_name, full_name').eq('id', booking.merchant_id).maybeSingle(),
  ])

  return {
    bookingId: booking.id,
    bookingReference: booking.booking_reference ?? booking.id.slice(0, 8).toUpperCase(),
    listingId: booking.listing_id,
    listingTitle: listing?.title ?? 'Listing',
    renterId: booking.renter_id,
    renterName: displayName(renterProfile),
    merchantId: booking.merchant_id,
    merchantName: displayName(merchantProfile),
    startAt: booking.start_at,
    endAt: booking.end_at,
    paymentDueAt: booking.payment_due_at,
    subtotalAmount: booking.subtotal_amount,
    depositAmount: booking.deposit_amount_snapshot,
    totalAmount: booking.renter_total_amount,
    currency: booking.currency ?? 'ZAR',
  }
}

export interface ListingEmailContext {
  listingId: string
  listingTitle: string
  merchantId: string
  merchantName: string
}

export async function loadListingEmailContext(admin: SupabaseClient, listingId: string): Promise<ListingEmailContext | null> {
  const { data: listing } = await admin.from('listings').select('id, title, merchant_id').eq('id', listingId).maybeSingle()
  if (!listing) return null

  const { data: merchantProfile } = await admin.from('profiles').select('display_name, full_name').eq('id', listing.merchant_id).maybeSingle()

  return {
    listingId: listing.id,
    listingTitle: listing.title,
    merchantId: listing.merchant_id,
    merchantName: displayName(merchantProfile),
  }
}

export async function loadUserDisplayName(admin: SupabaseClient, userId: string): Promise<string> {
  const { data } = await admin.from('profiles').select('display_name, full_name').eq('id', userId).maybeSingle()
  return displayName(data)
}
