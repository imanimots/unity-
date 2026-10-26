import type { SupportLinkedEntityType } from '@/lib/support/types'

/**
 * Bounded entity-type -> admin route map (Part 10 -- "do not allow
 * arbitrary route/URL injection"). SUPPORT_LINKED_ENTITY_TYPES is
 * itself a closed enum both in Postgres and in src/lib/support/types.ts,
 * and this switch is exhaustive over it, so there is no code path that
 * can turn caller-supplied data into an arbitrary href -- an entity
 * type with no admin detail page yet simply returns null and the
 * caller renders id+type as plain text instead of a broken/injected link.
 */
export function buildSupportLinkedEntityHref(type: SupportLinkedEntityType, id: string): string | null {
  switch (type) {
    case 'customer':
      return `/admin/users/${id}`
    case 'merchant':
      return `/admin/merchants/${id}`
    case 'listing':
      return `/admin/listings/${id}`
    case 'booking':
      return `/admin/bookings?id=${id}`
    case 'order':
      return `/admin/orders/${id}`
    case 'barter':
      return `/admin/barter/${id}`
    case 'rent_to_buy':
      return `/admin/rent-to-buy/${id}`
    case 'looking_for':
      return `/admin/marketplace-requests/${id}`
    case 'dispute':
      return `/admin/disputes/${id}`
    case 'payout':
      return `/admin/payouts/${id}`
    case 'subscription':
      return `/admin/subscriptions/${id}`
    case 'affiliate':
      return `/admin/affiliates/${id}`
    case 'advertising':
      // No single-item admin detail page exists for advertising yet --
      // the list page is the safest known destination.
      return '/admin/advertising'
    default:
      return null
  }
}

export const SUPPORT_LINKED_ENTITY_LABELS: Record<SupportLinkedEntityType, string> = {
  customer: 'Customer',
  merchant: 'Merchant',
  listing: 'Listing',
  booking: 'Booking',
  order: 'Order',
  barter: 'Barter trade',
  rent_to_buy: 'Rent-to-Buy agreement',
  looking_for: 'Looking For request',
  dispute: 'Dispute',
  payout: 'Payout',
  subscription: 'Subscription',
  affiliate: 'Affiliate',
  advertising: 'Advertising item',
}
