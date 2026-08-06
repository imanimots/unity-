-- ============================================================
-- Step 11 Phase 7 -- widen email_deliveries.related_entity_type
-- ============================================================
-- Adds 'affiliate_commission' (a qualified commission event) and
-- 'profile' (a user-level event with no listing/transaction attached,
-- e.g. affiliate.enrolled -- using 'listing' for that would have been
-- semantically wrong, so a real new entity type is added rather than
-- misusing an existing one), mirroring the exact pattern from
-- 20260813000002 (Step 11 Phase 1's own order/barter_agreement
-- widening) -- drop and recreate the same named constraint, additive
-- only.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

alter table public.email_deliveries drop constraint email_deliveries_related_entity_type_check;

alter table public.email_deliveries add constraint email_deliveries_related_entity_type_check check (
  related_entity_type = any (array['booking', 'listing', 'identity_verification', 'order', 'barter_agreement', 'affiliate_commission', 'profile'])
);
