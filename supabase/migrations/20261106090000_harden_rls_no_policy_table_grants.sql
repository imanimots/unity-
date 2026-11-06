-- ============================================================
-- E17 -- Grant hardening for the 14 RLS-enabled/zero-policy tables
-- ============================================================
-- A fresh, independent re-audit (3 parallel repo-wide traces, each
-- covering creation migrations, every SECURITY DEFINER/INVOKER
-- function body, every .from()/.rpc() call site in src/, admin UI,
-- cron/webhook routes, and tests) confirms all 14 tables flagged by
-- the advisor's rls_enabled_no_policy finding are a single, deliberate,
-- consistently-documented architecture, not an oversight:
--
--   barter_skill_task_post_reports, escrow_provider_events,
--   escrow_transaction_history, idempotency_keys,
--   kyc_document_upload_intents, kyc_legacy_finalize_daily_metrics,
--   ledger_entries, merchant_payout_history, payment_webhook_events,
--   profile_reports, review_moderation_history, review_reports,
--   review_windows, reviews_v2_config
--
-- Every one of them already has RLS enabled and zero CREATE POLICY
-- statements anywhere in migration history -- confirmed by direct
-- static scan, not merely trusted from the advisor. Per Supabase's own
-- documented semantics, this is already a true client deny-all via
-- PostgREST/Data API: "once RLS is enabled, no data is accessible
-- through the API using normal client roles until a policy grants
-- access." No table in this set has any proven anon/authenticated
-- direct-table-access requirement -- every real read/write path found
-- goes through one of:
--   - a service-role Supabase client (admin routes, orchestrators,
--     webhook handlers, internal/cron routes) -- bypasses RLS entirely
--     by Postgres/Supabase design, so client-role policies are
--     irrelevant to it;
--   - a SECURITY DEFINER function that itself raises unless
--     auth.role() = 'service_role' (the large majority of writers
--     here), or, for the narrow exception of
--     finalize_kyc_document_upload (already revalidated in E15) and
--     the 3 report-submission RPCs (report_profile,
--     report_barter_skill_task_post, report_review_content), a
--     narrowly-scoped RPC that derives/verifies the actor's identity
--     itself before writing.
-- No genuine missing client access path was found for any of the 14
-- tables -- see this phase's final report for the full per-table
-- decision matrix and evidence trail. Per the brief's own Part 6, the
-- goal here is a proven access model for all 14, not a reduced count;
-- this migration does not add a single new policy.
--
-- The one concrete, evidence-backed change: NONE of these 14 tables
-- has ever had an explicit GRANT or REVOKE statement anywhere in
-- migration history (confirmed by grep across all 248 prior
-- migrations). That means they still carry Supabase's original
-- default table privileges -- SELECT, INSERT, UPDATE, DELETE granted
-- to anon/authenticated/service_role automatically at table-creation
-- time (platform-level default, predating this repo's later move to
-- requiring explicit grants) -- and RLS-enabled-zero-policy is
-- currently the ONLY layer blocking anon/authenticated from reading or
-- writing these tables directly. This migration adds a second,
-- independent layer of defense-in-depth, exactly as Part 10/33 of this
-- phase's brief describes: explicitly revoking the client-role table
-- privileges that no proven access path ever needs, so that RLS being
-- misconfigured or a permissive policy being added by mistake in the
-- future would not, on its own, expose these tables. service_role is
-- deliberately left untouched -- every legitimate writer/reader in
-- this entire audit uses service_role, and service_role's own
-- privileges (and its RLS-bypass behavior) are independent of this
-- revoke regardless.
--
-- No RLS policy is added or changed. No schema relocation. No table
-- is dropped. Forward-only -- no historical migration is edited.
-- ============================================================

revoke select, insert, update, delete on table public.barter_skill_task_post_reports from public, anon, authenticated;
revoke select, insert, update, delete on table public.escrow_provider_events from public, anon, authenticated;
revoke select, insert, update, delete on table public.escrow_transaction_history from public, anon, authenticated;
revoke select, insert, update, delete on table public.idempotency_keys from public, anon, authenticated;
revoke select, insert, update, delete on table public.kyc_document_upload_intents from public, anon, authenticated;
revoke select, insert, update, delete on table public.kyc_legacy_finalize_daily_metrics from public, anon, authenticated;
revoke select, insert, update, delete on table public.ledger_entries from public, anon, authenticated;
revoke select, insert, update, delete on table public.merchant_payout_history from public, anon, authenticated;
revoke select, insert, update, delete on table public.payment_webhook_events from public, anon, authenticated;
revoke select, insert, update, delete on table public.profile_reports from public, anon, authenticated;
revoke select, insert, update, delete on table public.review_moderation_history from public, anon, authenticated;
revoke select, insert, update, delete on table public.review_reports from public, anon, authenticated;
revoke select, insert, update, delete on table public.review_windows from public, anon, authenticated;
revoke select, insert, update, delete on table public.reviews_v2_config from public, anon, authenticated;
