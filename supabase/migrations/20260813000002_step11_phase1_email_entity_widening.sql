-- ============================================================
-- Step 11 Phase 1 -- widen email_deliveries.related_entity_type
-- ============================================================
-- Adds 'order' and 'barter_agreement' to the set of entity types an
-- email delivery row can reference. This only widens what the column
-- PERMITS -- no new templates or event-dispatch call sites are added
-- in this phase (those land in Phase 4/6, when order and barter email
-- events actually get built).
--
-- The real live constraint name (confirmed via pg_constraint, not
-- guessed from the inline-CHECK SQL shape in the original migration)
-- is email_deliveries_related_entity_type_check.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

alter table public.email_deliveries drop constraint email_deliveries_related_entity_type_check;

alter table public.email_deliveries add constraint email_deliveries_related_entity_type_check check (
  related_entity_type = any (array['booking', 'listing', 'identity_verification', 'order', 'barter_agreement'])
);
