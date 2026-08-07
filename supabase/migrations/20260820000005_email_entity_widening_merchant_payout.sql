-- ============================================================
-- Step 11 Phase 8 -- widen email_deliveries.related_entity_type
-- ============================================================
-- Adds 'merchant_payout', mirroring the exact pattern from
-- 20260819000009 (Step 11 Phase 7's own affiliate_commission/profile
-- widening) -- drop and recreate the same named constraint, additive
-- only.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

alter table public.email_deliveries drop constraint email_deliveries_related_entity_type_check;

alter table public.email_deliveries add constraint email_deliveries_related_entity_type_check check (
  related_entity_type = any (array['booking', 'listing', 'identity_verification', 'order', 'barter_agreement', 'affiliate_commission', 'profile', 'merchant_payout'])
);
