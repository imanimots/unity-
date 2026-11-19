-- Platform improvement programme, Phase 3 (Analytics): the audit found
-- the 16-event taxonomy (20261027145645_analytics_events_foundation.sql)
-- had no payment/handover/return/refund/dispute/payout events at all --
-- visible only up to booking/order CREATION, with the entire
-- post-booking fulfillment funnel untracked. This extends the same
-- allowlist CHECK constraint with 6 new event names and 2 new entity
-- types, exactly the same way the original foundation migration
-- defined them -- never a parallel mechanism.
alter table public.analytics_events drop constraint if exists analytics_events_event_name_check;
alter table public.analytics_events add constraint analytics_events_event_name_check check (event_name in (
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
  -- New in this phase:
  'payment_outcome',
  'handover_confirmed',
  'return_confirmed',
  'refund_issued',
  'dispute_opened',
  'payout_processed'
));

alter table public.analytics_events drop constraint if exists analytics_events_entity_type_check;
alter table public.analytics_events add constraint analytics_events_entity_type_check check (entity_type is null or entity_type in ('listing', 'booking', 'order', 'dispute', 'payout'));
