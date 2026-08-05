-- ============================================================
-- Step 11 Phase 2 -- widen dispute_status for the generic dispute
-- lifecycle (bookings + orders + barter)
-- ============================================================
-- Current live enum: ('open', 'resolved', 'escalated') -- confirmed via
-- pg_enum immediately before writing this migration, not assumed from
-- the original migration source.
--
-- New lifecycle: open -> evidence -> under_review -> resolved -> closed,
-- plus a cancelled side-branch. 'escalated' is left in place, unused by
-- the new workflow -- Postgres can't cheaply drop an enum value, and
-- doing so would be a destructive migration this project's own rules
-- avoid. Adding multiple new values in one migration/transaction is
-- safe; only USING a value in the same transaction it was added is the
-- restriction (already established precedent in this project, e.g.
-- 20260810000002_payment_type_barter_values.sql added two values at
-- once). Nothing in this migration references the new values yet.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

alter type dispute_status add value if not exists 'evidence' after 'open';
alter type dispute_status add value if not exists 'under_review' after 'evidence';
alter type dispute_status add value if not exists 'closed' after 'resolved';
alter type dispute_status add value if not exists 'cancelled' after 'closed';
