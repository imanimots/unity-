/**
 * Unity -- D2 First-Party Event Analytics Foundation. The canonical,
 * allowlisted set of behavioral event names -- every event name used
 * anywhere in the app (client trackEvent() calls, server
 * recordAnalyticsEvent() calls, the ingestion route's validation, and
 * the analytics_events table's own CHECK constraint) must come from
 * this single list. No raw string literal for an event name should
 * ever appear outside this file.
 *
 * Every event here corresponds to a real, verified application flow
 * (ADMIN-CONTROL-CENTRE-BATCH-D2 Section 1 recon). Two candidate events
 * from the brief -- favorite_added/favorite_removed and
 * contact_owner_clicked -- are deliberately absent: there is no
 * favorites/watchlist feature and no pre-transaction "contact owner"
 * entry point anywhere in this codebase (messaging only exists after a
 * booking/order/barter/dispute already exists). They are not
 * instrumented because the flow does not exist, not because they were
 * forgotten.
 */
export const ANALYTICS_EVENT_NAMES = [
  'page_view',
  'signup_started',
  'signup_completed',
  'search_started',
  'search_results_viewed',
  'search_zero_results',
  'search_refined',
  'listing_viewed',
  'listing_creation_started',
  'listing_published',
  'rental_checkout_started',
  'booking_created',
  'order_checkout_started',
  'order_created',
  'kyc_started',
  'kyc_submitted',
  // Platform improvement programme, Phase 3: the post-booking/order
  // fulfillment funnel (payment outcome through to payout) had zero
  // instrumentation -- these 6 close that gap, following the exact
  // same allowlist + strict-schema + service-role-only-write pattern
  // as every event above.
  'payment_outcome',
  'handover_confirmed',
  'return_confirmed',
  'refund_issued',
  'dispute_opened',
  'payout_processed',
] as const

export type AnalyticsEventName = (typeof ANALYTICS_EVENT_NAMES)[number]

export const ANALYTICS_ENTITY_TYPES = ['listing', 'booking', 'order', 'dispute', 'payout'] as const
export type AnalyticsEntityType = (typeof ANALYTICS_ENTITY_TYPES)[number]
