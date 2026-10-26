/**
 * Single source of truth for the Support Centre's bounded taxonomies
 * (ADMIN-CONTROL-CENTRE-BATCH-A2) -- mirrored exactly by the enum
 * definitions in supabase/migrations/20261026000000_support_centre_
 * schema.sql. Both src/lib/support/validation.ts (zod) and the UI
 * import these same arrays rather than redeclaring the lists, so a
 * category/status/priority can never silently drift between the
 * database, the API validation layer, and what the dropdowns offer.
 */

export const SUPPORT_CASE_CATEGORIES = [
  'account_access',
  'identity_kyc',
  'listing_ownership',
  'rental_booking',
  'buy_sell_order',
  'barter',
  'rent_to_buy',
  'looking_for',
  'payment',
  'deposit_refund',
  'payout',
  'subscription',
  'affiliate_ambassador',
  'advertising',
  'dispute_trust_safety',
  'privacy_popia',
  'technical_issue',
  'general_other',
] as const

export type SupportCaseCategory = (typeof SUPPORT_CASE_CATEGORIES)[number]

export const SUPPORT_CASE_CATEGORY_LABELS: Record<SupportCaseCategory, string> = {
  account_access: 'Account access',
  identity_kyc: 'Identity / KYC',
  listing_ownership: 'Listing / ownership',
  rental_booking: 'Rental / booking',
  buy_sell_order: 'Buy / sell order',
  barter: 'Barter',
  rent_to_buy: 'Rent-to-Buy',
  looking_for: 'Looking For',
  payment: 'Payment',
  deposit_refund: 'Deposit / refund',
  payout: 'Payout',
  subscription: 'Subscription',
  affiliate_ambassador: 'Affiliate / ambassador',
  advertising: 'Advertising',
  dispute_trust_safety: 'Dispute / trust & safety',
  privacy_popia: 'Privacy / POPIA',
  technical_issue: 'Technical issue',
  general_other: 'General / other',
}

export const SUPPORT_CASE_STATUSES = ['open', 'in_progress', 'waiting_on_user', 'escalated', 'resolved', 'closed'] as const
export type SupportCaseStatus = (typeof SUPPORT_CASE_STATUSES)[number]

export const SUPPORT_CASE_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const
export type SupportCasePriority = (typeof SUPPORT_CASE_PRIORITIES)[number]

export const SUPPORT_CASE_SOURCES = ['admin_created', 'system_generated'] as const
export type SupportCaseSource = (typeof SUPPORT_CASE_SOURCES)[number]

export const SUPPORT_LINKED_ENTITY_TYPES = [
  'customer', 'merchant', 'listing', 'booking', 'order', 'barter',
  'rent_to_buy', 'looking_for', 'dispute', 'payout', 'subscription',
  'affiliate', 'advertising',
] as const
export type SupportLinkedEntityType = (typeof SUPPORT_LINKED_ENTITY_TYPES)[number]

/**
 * "Soft" statuses reachable via update_support_case_status -- the
 * database RPC enforces the identical allow-list; this is purely for
 * the UI to know which status-change control to render where (it is
 * not the sole enforcement, see Part 17).
 */
export const SOFT_STATUSES: readonly SupportCaseStatus[] = ['open', 'in_progress', 'waiting_on_user']

export function isActiveSupportCaseStatus(status: SupportCaseStatus): boolean {
  return status === 'open' || status === 'in_progress' || status === 'waiting_on_user' || status === 'escalated'
}
