-- ============================================================
-- Clickable Customer Profiles -- final privacy hardening corrective
-- pass. Closes the one blocking issue from the provisional review:
-- `profiles` had "profiles: public read" using (true) -- an
-- unconditional row-level policy. Postgres RLS is row-level only, so
-- that policy granted every column (phone, is_affiliate,
-- affiliate_code, account_status, status_reason, status_changed_at,
-- status_changed_by, raw kyc_status) to any anon/authenticated
-- PostgREST client for any row, once visible at all -- regardless of
-- how carefully the application layer's own queries were written.
-- ============================================================
-- This migration deliberately supersedes the stale assumption recorded
-- in 20260808000001_account_status_and_admin_notes.sql's own comment
-- ("account_status is not sensitive... the public read policy already
-- exposes role/kyc_status the same way") -- that reasoning is exactly
-- what this corrective pass closes.
--
-- Architecture (audited first -- see the accompanying report for the
-- full consumer classification):
--   A. PUBLIC MARKETPLACE IDENTITY -- the new public_profiles view.
--      Exposes only: id, display_name, full_name, avatar_url, role,
--      is_verified (derived boolean, never raw kyc_status), unity_score,
--      created_at. Granted SELECT to anon + authenticated. Views run
--      with the CREATING role's privileges for underlying-table access
--      (Postgres's default, un-set `security_invoker` behaviour) -- so
--      this view keeps working for every row regardless of the tightened
--      base-table policy below, while its own fixed column list is the
--      hard boundary: no future private column on `profiles` can leak
--      through it merely by existing.
--   B. SELF PRIVATE PROFILE -- unchanged. Every existing self-read
--      (getRequestProfile(), getServerUser(), the client-side auth hook,
--      middleware's own role check, /api/profile/country) already
--      scopes its query by the caller's own auth.uid()-derived id, so
--      the new `auth.uid() = id` SELECT policy below satisfies these
--      exactly as before -- no new self-profile RPC is required.
--   C. ADMIN / TRUST / INTERNAL -- unchanged. Every admin service file,
--      admin route, email-context loader, notification helper, and the
--      escrow orchestrator already reads `profiles` through an explicit
--      service-role client (getAdminServiceClient() or an `admin:
--      SupabaseClient` parameter) -- service_role bypasses RLS
--      entirely in Supabase, so none of these are affected by the
--      tightened base-table policy.
--   D. Two real, previously-live over-exposures found and fixed at the
--      application layer alongside this migration (see the
--      accompanying code changes, not this file): GET
--      /api/orders/[id] was embedding the FULL profiles(*) row (phone,
--      account_status, affiliate_code, etc.) for BOTH the buyer and
--      the seller via the session client -- meaning any order
--      participant could already read their counterparty's private
--      fields today, independent of this migration. The barter
--      dashboard detail page read both parties' names via the base
--      table with the session client. Both now read through
--      public_profiles instead.
--
-- Never touches: "profiles: own update" (unchanged, still
-- auth.uid() = id), protect_profile_privileged_fields_trg (unchanged),
-- KYC workflow, any RPC.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

create view public.public_profiles as
select
  id,
  display_name,
  full_name,
  avatar_url,
  role,
  (kyc_status = 'approved') as is_verified,
  unity_score,
  created_at
from public.profiles;

grant select on public.public_profiles to anon, authenticated;

drop policy if exists "profiles: public read" on public.profiles;

create policy "profiles: own read"
  on public.profiles for select
  using (auth.uid() = id);
