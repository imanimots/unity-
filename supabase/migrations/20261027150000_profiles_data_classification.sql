-- ============================================================
-- Unity -- D3-A Profile/Account-Level QA Classification (F1: three-state).
--
-- D3-A originally shipped this as a plain boolean column.
-- The independent review's sole P1 finding: a boolean cannot
-- distinguish "confirmed real" from "unknown provenance" -- every
-- existing, unresolved legacy account (6 of 9 @unitytest.co.za
-- accounts, both @gmail.com accounts) would have landed on the same
-- `false` value as a genuinely real account, with no way for a
-- future Real Data filter to tell them apart without silently
-- promoting unknowns to real. This migration (still unapplied --
-- modified in place rather than compensated with a second migration)
-- replaces the boolean with an explicit three-state model:
--
--   real    -- the ordinary default for future profile creation, or
--              a profile explicitly, authoritatively classified real.
--   test    -- positively confirmed QA/test account (structural
--              @unitytest.internal domain match, or one of exactly 3
--              historical @unitytest.co.za accounts with direct,
--              named source-document evidence -- never a domain-wide
--              rule for .co.za, since that domain is ALSO Unity's
--              real corporate contact domain).
--   unknown -- provenance has not been positively established either
--              way. This is the critical addition: every EXISTING
--              profile at migration time starts here, not at a value
--              that could be mistaken for "real."
--
-- CONTRACT FOR ALL FUTURE ADMIN RUNTIME CODE (D3-B onward):
--   Real Data mode MUST filter with the positive equality
--     data_classification = 'real'
--   and MUST NEVER filter with the negative
--     data_classification <> 'test'
--   -- the latter would silently include 'unknown' rows as if they
--   were confirmed real, which is exactly the bug this migration
--   exists to prevent. 'unknown' must never be implicitly counted as
--   real anywhere in this codebase.
--
-- Entity-level is_test columns (listings, marketplace_requests,
-- barter_skill_task_posts, rent_to_buy_agreements, reviews,
-- review_replies, review_windows, ad_advertisers, ad_campaigns,
-- ad_creatives, etc.) are untouched -- this column complements them,
-- it does not replace them.
-- ============================================================

-- STEP 1: add the column with its LEGACY-SAFE initial default --
-- 'unknown', not 'real'. Every profile that exists at the moment this
-- migration runs (every current row, confirmed-real or not) starts
-- here. This is intentional: it is what makes "unknown can never
-- silently become real" true by construction, not by convention.
alter table public.profiles
  add column if not exists data_classification text not null default 'unknown'
  check (data_classification in ('real', 'test', 'unknown'));

-- Extends the LATEST effective privilege-escalation-protection
-- trigger with data_classification, rather than inventing a new
-- mechanism. This function has been redefined twice before this
-- migration -- 20260729000001_fix_rls_privilege_escalation.sql
-- (role/kyc_status/unity_score/is_affiliate/affiliate_code) and then
-- 20260808000001_account_status_and_admin_notes.sql, which ADDED
-- account_status/status_reason/status_changed_at/status_changed_by
-- to the same guard. D3-A/F1's first version of this migration was
-- written against only the first (older) definition and would have
-- silently DROPPED the account-status protections on application --
-- a real P1 regression (an ordinary suspended/restricted user could
-- have self-reactivated via a direct profile update), caught by an
-- independent live-trigger inspection before this migration was ever
-- applied. This version preserves every field from BOTH prior
-- definitions and adds only data_classification: any non-service_role
-- caller's attempted change to any of these ten fields, in any
-- direction, is silently reverted to the row's previous value, so an
-- ordinary profile update (e.g. changing display_name) can never also
-- smuggle in a privileged change, without failing the whole request.
create or replace function public.protect_profile_privileged_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then
    new.role := old.role;
    new.kyc_status := old.kyc_status;

    if pg_trigger_depth() <= 1 then
      new.unity_score := old.unity_score;
    end if;

    new.is_affiliate := old.is_affiliate;
    new.affiliate_code := old.affiliate_code;

    -- account_status / status_reason / status_changed_at /
    -- status_changed_by: added by 20260808000001_account_status_and_admin_notes.sql
    -- -- preserved here unchanged, never dropped.
    new.account_status := old.account_status;
    new.status_reason := old.status_reason;
    new.status_changed_at := old.status_changed_at;
    new.status_changed_by := old.status_changed_by;

    -- data_classification (D3-A/F1): no client-facing path exists or
    -- will exist for this column -- it is migration/service-role
    -- only. handle_new_user() (the only INSERT path) never sets it
    -- either, so it always takes the column DEFAULT on creation (see
    -- STEP 3 below for what that default is at the end of this file).
    new.data_classification := old.data_classification;
  end if;
  return new;
end;
$$;

-- STEP 2: backfill ONLY positively confirmed QA accounts to 'test'.
-- Every row not matched here simply stays at its STEP 1 default of
-- 'unknown' -- there is no broad "everything else is real" pass.

-- A. @unitytest.internal -- confirmed, structural, domain-wide (the
-- D3 audit proved this domain is airtight: an IANA-reserved,
-- non-routable .internal TLD that appears nowhere outside QA/test
-- code in this repository).
update public.profiles
set data_classification = 'test'
where data_classification = 'unknown'
  and id in (
    select id from auth.users where lower(email) like '%@unitytest.internal'
  );

-- B. @unitytest.co.za -- exactly the 3 historical QA identities with
-- direct, named source evidence (docs/ADMIN_OPERATIONS.md,
-- docs/MOCK_CHECKOUT.md, docs/TRANSACTIONAL_EMAILS.md -- see this
-- phase's implementation report for the full provenance table).
-- Never a domain-wide match: this domain is ALSO Unity's real
-- corporate contact domain (support@/legal@/privacy@unitytest.co.za
-- are genuine, live, user-facing addresses), so an email-domain rule
-- here would be unsafe. The other 6 live @unitytest.co.za accounts,
-- and both @gmail.com accounts, have no source evidence proving them
-- QA and are deliberately left at 'unknown' -- never guessed at.
update public.profiles
set data_classification = 'test'
where data_classification = 'unknown'
  and id in (
    '55b01021-c9be-4f0e-b298-d865ab21feea', -- phase2a-renter-c@unitytest.co.za (docs/ADMIN_OPERATIONS.md, docs/MOCK_CHECKOUT.md, docs/TRANSACTIONAL_EMAILS.md)
    '0a4c00d5-a20e-4a12-bb2c-104e66399c7c', -- phase2a-merchant-a@unitytest.co.za (docs/ADMIN_OPERATIONS.md, docs/MOCK_CHECKOUT.md, docs/TRANSACTIONAL_EMAILS.md)
    '2b418e42-d343-48cb-9d98-f966ef94d749'  -- step8-qa-admin@unitytest.co.za (docs/ADMIN_OPERATIONS.md, docs/TRANSACTIONAL_EMAILS.md)
  );

-- No gmail.com account is classified by this migration -- provenance
-- unresolved per the D3 audit; left at 'unknown', never backfilled to
-- either 'real' or 'test'.

-- STEP 3: only NOW, after every existing row has been resolved to
-- either 'test' (confirmed QA) or left at 'unknown' (everything
-- else), change the column's DEFAULT for FUTURE rows to 'real'.
-- ALTER COLUMN ... SET DEFAULT never rewrites existing rows -- it
-- only changes what a future INSERT gets when it omits this column,
-- which is exactly handle_new_user()'s behavior (it never mentions
-- data_classification in its own INSERT column list, so every new,
-- ordinary signup after this migration gets 'real' purely from this
-- default -- never from client-supplied signup metadata).
alter table public.profiles alter column data_classification set default 'real';
