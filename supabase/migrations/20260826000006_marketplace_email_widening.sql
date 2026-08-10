-- ============================================================
-- Phase 4 -- email_deliveries.related_entity_type widening for
-- marketplace request/offer notifications, matching every prior
-- phase's exact pattern.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

alter table public.email_deliveries drop constraint email_deliveries_related_entity_type_check;

alter table public.email_deliveries add constraint email_deliveries_related_entity_type_check check (
  related_entity_type = any (array['booking', 'listing', 'identity_verification', 'order', 'barter_agreement', 'affiliate_commission', 'profile', 'merchant_payout', 'merchant_subscription', 'unity_commission', 'escrow_transaction', 'marketplace_request'])
);
