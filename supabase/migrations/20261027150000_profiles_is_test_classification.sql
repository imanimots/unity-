-- ============================================================
-- Unity -- D3-A Profile/Account-Level QA Classification.
--
-- Adds the canonical, server-controlled account-level test marker the
-- D3 audit identified as missing: profiles has no is_test column
-- today, so Admin surfaces that count/list profiles (Overview,
-- Customers, Merchants, KYC) have no way to exclude QA/seed accounts.
-- This migration adds ONLY the column + its write protection + a
-- narrow, evidence-based backfill. It does not touch entity-level
-- is_test columns (listings, marketplace_requests, etc.), which
-- remain authoritative for their own entities and are addressed in a
-- later phase.
--
-- Backfill sources (both narrow, neither a runtime rule):
--   A. @unitytest.internal -- the D3 audit proved this domain is
--      airtight (IANA-reserved, non-routable .internal TLD; appears
--      nowhere outside QA/test code in this repository). Matched here
--      by exact domain suffix, case-insensitive.
--   B. @unitytest.co.za -- the D3 audit explicitly found this domain
--      is NOT airtight (it is also Unity's real corporate contact
--      domain -- support@/legal@/privacy@unitytest.co.za are genuine,
--      live, user-facing addresses). A domain-wide rule is therefore
--      deliberately NOT used. Instead, exactly the 9 live accounts
--      under this domain were cross-checked read-only against every
--      QA-account identity with direct, named source evidence in this
--      repository's own docs (docs/ADMIN_OPERATIONS.md,
--      docs/MOCK_CHECKOUT.md, docs/TRANSACTIONAL_EMAILS.md). Only 3 of
--      the 9 matched a documented identity exactly; those 3 UUIDs are
--      enumerated explicitly below. The other 6 have no source
--      evidence proving them QA and are deliberately left
--      unclassified (is_test stays false) rather than guessed at --
--      see this phase's own implementation report for the full
--      provenance table.
-- ============================================================

alter table public.profiles add column if not exists is_test boolean not null default false;

-- Extends the existing privilege-escalation-protection trigger
-- (20260729000001_fix_rls_privilege_escalation.sql) with is_test,
-- rather than inventing a new mechanism -- same pattern already
-- protecting role/kyc_status/unity_score/is_affiliate/affiliate_code:
-- any non-service_role caller's attempted change to is_test is
-- silently reverted to its previous value, so an ordinary profile
-- update (e.g. changing display_name) can never also smuggle in an
-- is_test change, without failing the whole request.
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

    -- is_test (D3-A): no client-facing path exists or will exist for
    -- this column -- it is migration/service-role only, same posture
    -- as listings.is_test (20260821000001_listings_is_test_column.sql).
    new.is_test := old.is_test;
  end if;
  return new;
end;
$$;

-- A. @unitytest.internal -- confirmed, structural, domain-wide.
update public.profiles
set is_test = true
where is_test = false
  and id in (
    select id from auth.users where lower(email) like '%@unitytest.internal'
  );

-- B. @unitytest.co.za -- exactly the 3 historical QA identities with
-- direct, named source evidence (see this phase's implementation
-- report for the full provenance table). Never a domain-wide match.
update public.profiles
set is_test = true
where is_test = false
  and id in (
    '55b01021-c9be-4f0e-b298-d865ab21feea', -- phase2a-renter-c@unitytest.co.za (docs/ADMIN_OPERATIONS.md, docs/MOCK_CHECKOUT.md, docs/TRANSACTIONAL_EMAILS.md)
    '0a4c00d5-a20e-4a12-bb2c-104e66399c7c', -- phase2a-merchant-a@unitytest.co.za (docs/ADMIN_OPERATIONS.md, docs/MOCK_CHECKOUT.md, docs/TRANSACTIONAL_EMAILS.md)
    '2b418e42-d343-48cb-9d98-f966ef94d749'  -- step8-qa-admin@unitytest.co.za (docs/ADMIN_OPERATIONS.md, docs/TRANSACTIONAL_EMAILS.md)
  );

-- No gmail.com account is classified by this migration -- provenance
-- unresolved per the D3 audit; left at the column default (false).
