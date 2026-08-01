-- ============================================================
-- Add 'suspended' to listing_status (Step 3, public-test MVP)
-- ============================================================
-- Distinct from the merchant's own self-service 'paused': 'suspended' is
-- an administrative action (docs/LISTING_SCHEMA.md's "Status vs.
-- moderation" table already reserves this exact distinction, calling out
-- that suspended/admin-approved-style values must join the existing
-- protect_listing_privileged_fields trigger, not ship as a plain
-- client-writable value -- done in 20260803000003_admin_moderation_rpcs.sql,
-- which extends that trigger).
--
-- ALTER TYPE ... ADD VALUE cannot be used in the same transaction as a
-- statement that references the new value (a real Postgres restriction,
-- not a style choice) -- kept in its own migration file/transaction for
-- exactly that reason, applied before 20260803000003 references
-- 'suspended'::listing_status in RPC bodies.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

alter type listing_status add value if not exists 'suspended';
