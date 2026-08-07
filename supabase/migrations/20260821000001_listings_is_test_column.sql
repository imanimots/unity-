-- ============================================================
-- Unity SEO Pre-Launch Hardening -- listings.is_test
-- ============================================================
-- First-class test-fixture marker. Additive only -- no destructive
-- change, no existing column altered.
--
-- Backfill rule (provable from the existing seed/regression architecture,
-- not a guess): a listing is test data if EITHER
--   (a) its title begins '[QA]' or '[DEMO]' (the established fixture
--       naming convention used by every regression script and the
--       Step 11 Phase 7 demo-listing task), OR
--   (b) its owning profile's auth.users.email ends in
--       '@unitytest.internal' (the current scripts/qa-seed.mjs domain)
--       or '@unitytest.co.za' (an earlier, superseded QA-account
--       domain -- e.g. phase2a-merchant-a@unitytest.co.za, already
--       independently identified as a QA-only fixture account during
--       Step 11 Phase 8's own live audit).
--
-- Verified live before writing this migration: every one of the 124
-- listings in the dev project matches (a) or (b) -- zero listings fall
-- outside both rules, so this backfill has zero false positives and
-- zero false negatives against the current dev data. No listing is
-- classified as test merely because its title "looks unusual."
--
-- No RPC or client-writable path ever sets this column -- confirmed by
-- reading save_listing_draft() (20260729000007_listing_creation_rpc.sql),
-- which extracts only explicitly named fields from its p_listing jsonb
-- argument and has never referenced is_test. A client cannot set this
-- column through any existing create/edit path; it stays service-role/
-- migration-set only.
--
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

alter table public.listings
  add column if not exists is_test boolean not null default false;

comment on column public.listings.is_test is
  'True for QA/regression/demo fixture listings. Set only by migrations or trusted service-role tooling -- never by any client-facing create/edit RPC. Excluded from every public marketplace query path (browse, homepage, affiliate opportunity feed, sitemap); still visible to its owning account and to admin tooling.';

update public.listings
set is_test = true
where is_test = false
  and (
    title ilike '[QA]%'
    or title ilike '[DEMO]%'
    or merchant_id in (
      select id from auth.users
      where email like '%@unitytest.internal'
         or email like '%@unitytest.co.za'
    )
  );
