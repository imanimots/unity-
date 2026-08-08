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

export interface DisputeEmailContext {
  disputeId: string
  title: string
  raiserId: string
  raiserName: string
  respondentId: string
  respondentName: string
  transactionReference: string
}

/**
 * Resolves "the other party" generically from whichever of
 * booking_id/order_id/barter_agreement_id is set -- same pattern
 * open_dispute() itself uses to compute v_respondent_id, just re-derived
 * here since the RPC's result isn't always available at every dispatch
 * site (e.g. an admin action route only has dispute_id).
 */
export async function loadDisputeEmailContext(admin: SupabaseClient, disputeId: string): Promise<DisputeEmailContext | null> {
  const { data: dispute } = await admin.from('disputes').select('id, title, raised_by, booking_id, order_id, barter_agreement_id').eq('id', disputeId).maybeSingle()
  if (!dispute) return null

  let respondentId: string | null = null
  let transactionReference = ''

  if (dispute.booking_id) {
    const { data: booking } = await admin.from('bookings').select('booking_reference, renter_id, merchant_id').eq('id', dispute.booking_id).maybeSingle()
    if (booking) {
      transactionReference = booking.booking_reference ?? dispute.booking_id.slice(0, 8).toUpperCase()
      respondentId = booking.renter_id === dispute.raised_by ? booking.merchant_id : booking.renter_id
    }
  } else if (dispute.order_id) {
    const { data: order } = await admin.from('orders').select('order_reference, buyer_id, seller_id').eq('id', dispute.order_id).maybeSingle()
    if (order) {
      transactionReference = order.order_reference ?? dispute.order_id.slice(0, 8).toUpperCase()
      respondentId = order.buyer_id === dispute.raised_by ? order.seller_id : order.buyer_id
    }
  } else if (dispute.barter_agreement_id) {
    const { data: agreement } = await admin.from('barter_agreements').select('agreement_reference, party_a_id, party_b_id').eq('id', dispute.barter_agreement_id).maybeSingle()
    if (agreement) {
      transactionReference = agreement.agreement_reference ?? dispute.barter_agreement_id.slice(0, 8).toUpperCase()
      respondentId = agreement.party_a_id === dispute.raised_by ? agreement.party_b_id : agreement.party_a_id
    }
  }

  if (!respondentId) return null

  const [raiserName, respondentName] = await Promise.all([loadUserDisplayName(admin, dispute.raised_by), loadUserDisplayName(admin, respondentId)])

  return {
    disputeId: dispute.id,
    title: dispute.title,
    raiserId: dispute.raised_by,
    raiserName,
    respondentId,
    respondentName,
    transactionReference,
  }
}

export interface BarterEmailContext {
  agreementId: string
  agreementReference: string
  anchorListingTitle: string
  partyAId: string
  partyAName: string
  partyBId: string
  partyBName: string
}

/**
 * Step 11 Phase 4 -- the one shared query every barter email dispatch
 * call site uses to build its vars, mirroring loadDisputeEmailContext's
 * shape. Returns null if the agreement can't be found (the caller
 * should skip dispatch entirely, never fabricate context).
 */
export async function loadBarterEmailContext(admin: SupabaseClient, agreementId: string): Promise<BarterEmailContext | null> {
  const { data: agreement } = await admin
    .from('barter_agreements')
    .select('id, agreement_reference, anchor_listing_id, party_a_id, party_b_id')
    .eq('id', agreementId)
    .maybeSingle()
  if (!agreement) return null

  const [{ data: listing }, partyAName, partyBName] = await Promise.all([
    admin.from('listings').select('title').eq('id', agreement.anchor_listing_id).maybeSingle(),
    loadUserDisplayName(admin, agreement.party_a_id),
    loadUserDisplayName(admin, agreement.party_b_id),
  ])

  return {
    agreementId: agreement.id,
    agreementReference: agreement.agreement_reference,
    anchorListingTitle: listing?.title ?? 'Listing',
    partyAId: agreement.party_a_id,
    partyAName,
    partyBId: agreement.party_b_id,
    partyBName,
  }
}

export interface OrderEmailContext {
  orderId: string
  orderReference: string
  listingTitle: string
  buyerId: string
  buyerName: string
  sellerId: string
  sellerName: string
  totalAmount: number
  currency: string
}

/**
 * Step 11 Phase 6 -- the one shared query every order email dispatch call
 * site uses to build its vars, mirroring loadBarterEmailContext()'s
 * shape. `totalAmount` comes from the order row's own immutable
 * total_amount (snapshotted at create_order() time, never mutated after
 * -- see docs/ORDER_ADMINISTRATION.md). `listingTitle` is a live lookup
 * through listing_id -- orders has no listing-title snapshot column, so
 * a listing renamed after the sale changes what an old order email
 * displays, identical to loadBookingEmailContext()/
 * loadBarterEmailContext()'s own pre-existing behavior, not a new gap.
 * Returns null if the order can't be found (the caller should skip
 * dispatch entirely, never fabricate context).
 */
export async function loadOrderEmailContext(admin: SupabaseClient, orderId: string): Promise<OrderEmailContext | null> {
  const { data: order } = await admin
    .from('orders')
    .select('id, order_reference, listing_id, buyer_id, seller_id, total_amount')
    .eq('id', orderId)
    .maybeSingle()
  if (!order) return null

  const [{ data: listing }, buyerName, sellerName] = await Promise.all([
    admin.from('listings').select('title').eq('id', order.listing_id).maybeSingle(),
    loadUserDisplayName(admin, order.buyer_id),
    loadUserDisplayName(admin, order.seller_id),
  ])

  return {
    orderId: order.id,
    orderReference: order.order_reference,
    listingTitle: listing?.title ?? 'Listing',
    buyerId: order.buyer_id,
    buyerName,
    sellerId: order.seller_id,
    sellerName,
    totalAmount: order.total_amount,
    // orders has no currency column of its own (unlike bookings) -- the
    // platform is ZAR-only at launch, matching CLAUDE.md's "all monetary
    // values in ZAR" ground rule.
    currency: 'ZAR',
  }
}

export interface AffiliateCommissionEmailContext {
  commissionId: string
  listingTitle: string
  affiliateId: string
  affiliateName: string
  merchantId: string
  merchantName: string
  commissionAmount: number
  currency: string
  transactionReference: string
}

/**
 * Step 11 Phase 7 -- the one shared query every affiliate commission
 * email dispatch call site uses to build its vars. Reference (order/
 * booking) is resolved generically from whichever of order_id/booking_id
 * is set, mirroring loadDisputeEmailContext()'s own pattern. Returns
 * null if the commission can't be found (the caller should skip
 * dispatch entirely, never fabricate context).
 */
export async function loadAffiliateCommissionEmailContext(admin: SupabaseClient, commissionId: string): Promise<AffiliateCommissionEmailContext | null> {
  const { data: commission } = await admin
    .from('affiliate_commissions')
    .select('id, listing_id, affiliate_id, merchant_id, commission_amount, currency, order_id, booking_id')
    .eq('id', commissionId)
    .maybeSingle()
  if (!commission) return null

  const [{ data: listing }, affiliateName, merchantName, reference] = await Promise.all([
    admin.from('listings').select('title').eq('id', commission.listing_id).maybeSingle(),
    loadUserDisplayName(admin, commission.affiliate_id),
    loadUserDisplayName(admin, commission.merchant_id),
    (async () => {
      if (commission.order_id) {
        const { data } = await admin.from('orders').select('order_reference').eq('id', commission.order_id).maybeSingle()
        return data?.order_reference ?? commission.order_id.slice(0, 8).toUpperCase()
      }
      if (commission.booking_id) {
        const { data } = await admin.from('bookings').select('booking_reference').eq('id', commission.booking_id).maybeSingle()
        return data?.booking_reference ?? commission.booking_id.slice(0, 8).toUpperCase()
      }
      return commission.id.slice(0, 8).toUpperCase()
    })(),
  ])

  return {
    commissionId: commission.id,
    listingTitle: listing?.title ?? 'Listing',
    affiliateId: commission.affiliate_id,
    affiliateName,
    merchantId: commission.merchant_id,
    merchantName,
    commissionAmount: commission.commission_amount,
    currency: commission.currency ?? 'ZAR',
    transactionReference: reference,
  }
}

export interface UnityCommissionEmailContext {
  commissionId: string
  listingTitle: string
  merchantId: string
  merchantName: string
  commissionAmount: number
  currency: string
  transactionReference: string
}

/**
 * Unity Phase 2 -- the one shared query every Unity commission email
 * dispatch call site uses to build its vars. Mirrors
 * loadAffiliateCommissionEmailContext()'s exact shape. Returns null if
 * the commission can't be found (the caller should skip dispatch
 * entirely, never fabricate context).
 */
export async function loadUnityCommissionEmailContext(admin: SupabaseClient, commissionId: string): Promise<UnityCommissionEmailContext | null> {
  const { data: commission } = await admin
    .from('unity_commissions')
    .select('id, listing_id, merchant_id, commission_amount, currency, order_id, booking_id')
    .eq('id', commissionId)
    .maybeSingle()
  if (!commission) return null

  const [{ data: listing }, merchantName, reference] = await Promise.all([
    admin.from('listings').select('title').eq('id', commission.listing_id).maybeSingle(),
    loadUserDisplayName(admin, commission.merchant_id),
    (async () => {
      if (commission.order_id) {
        const { data } = await admin.from('orders').select('order_reference').eq('id', commission.order_id).maybeSingle()
        return data?.order_reference ?? commission.order_id.slice(0, 8).toUpperCase()
      }
      if (commission.booking_id) {
        const { data } = await admin.from('bookings').select('booking_reference').eq('id', commission.booking_id).maybeSingle()
        return data?.booking_reference ?? commission.booking_id.slice(0, 8).toUpperCase()
      }
      return commission.id.slice(0, 8).toUpperCase()
    })(),
  ])

  return {
    commissionId: commission.id,
    listingTitle: listing?.title ?? 'Listing',
    merchantId: commission.merchant_id,
    merchantName,
    commissionAmount: commission.commission_amount,
    currency: commission.currency ?? 'ZAR',
    transactionReference: reference,
  }
}

export interface AffiliateListingEmailContext {
  listingId: string
  listingTitle: string
  merchantId: string
  merchantName: string
}

export async function loadAffiliateListingEmailContext(admin: SupabaseClient, listingId: string): Promise<AffiliateListingEmailContext | null> {
  const { data: listing } = await admin.from('listings').select('id, title, merchant_id').eq('id', listingId).maybeSingle()
  if (!listing) return null
  const merchantName = await loadUserDisplayName(admin, listing.merchant_id)
  return { listingId: listing.id, listingTitle: listing.title, merchantId: listing.merchant_id, merchantName }
}
