-- ============================================================
-- E8-F1 -- Security invoker corrective architecture
-- ============================================================
-- This migration REPLACES the original E8 draft of this same file
-- (which, after a first audit, kept all 8 advisor-flagged views as
-- SECURITY DEFINER with only security_barrier added). That first draft
-- was never applied anywhere, so it is corrected in place here rather
-- than superseded by a second migration (there is nothing live to
-- fix-forward from).
--
-- A fresh, adversarial re-audit -- this time checking every EXISTING
-- direct caller of each underlying base table, not just each view's
-- own callers -- found that 4 of the 8 views CAN safely convert to
-- `security_invoker = true` (the caller-privilege model Postgres 15+
-- and Supabase's own guidance prefer), by pairing a narrow owner/
-- public RLS policy with an explicit, narrow COLUMN-LEVEL grant on the
-- base table. The other 4 genuinely cannot, for reasons specific to
-- each (documented at each view below) -- not because converting them
-- is merely inconvenient, but because doing so would either (a) break
-- an existing legitimate caller's required functionality, or (b)
-- widen exposure for a role beyond what column-level privileges can
-- safely contain, which the priority order below explicitly forbids
-- trading away just to clear a lint finding.
--
-- Priority order followed for every decision in this migration:
--   1. Prevent unauthorized data access
--   2. Preserve required functionality
--   3. Apply RLS at the correct trust boundary
--   4. Minimize direct base-table grants
--   5. Reduce advisor findings
--
-- CONVERTED to security_invoker = true (4 views):
--   1. listing_moderation_merchant_view
--   2. listing_ownership_verification_merchant_view
--   3. identity_verification_self_view
--   8. ad_packages_public
--
-- RETAINED as a justified SECURITY DEFINER exception (4 views), each
-- independently re-proven below, not copied from the prior audit:
--   4. barter_locked_listings
--   5. rent_to_buy_locked_listings
--   6. public_profiles
--   7. barter_skill_task_public_posts (reclassified from the earlier,
--      too-hasty E8 take, which had NOT yet checked for an existing
--      authenticated-session caller needing full-column self-access --
--      see its own section below for why that single fact changes the
--      conclusion)
--
-- Postgres version: 15 (supabase/config.toml, major_version = 15),
-- which supports `security_invoker` on views.
-- ============================================================

-- ════════════════════════════════════════════════════════════════
-- 1. listing_moderation_merchant_view -- CONVERTED to security_invoker
-- ════════════════════════════════════════════════════════════════
-- Checked every direct caller of the base table `listing_moderation`
-- across the whole repo: every one of them (admin listing detail,
-- admin listing activation, exceptions-service's pending-review sweep)
-- uses the service-role (`admin`) client, which bypasses RLS/grants
-- entirely -- none uses the authenticated session client. There is
-- therefore no existing requirement for `authenticated` to hold
-- broader-than-merchant-safe column access to this table, which is
-- exactly the condition that makes a safe conversion possible here.
--
-- Base-table privilege state is made explicit rather than assumed
-- (Part I): the role's default/no-op prior grant is revoked, then an
-- explicit, narrow, column-level SELECT grant is issued covering only
-- the same 4 columns the merchant view has always exposed --
-- moderation_notes and moderated_by (the reviewing admin's id) are
-- deliberately never granted, so they remain inaccessible even via a
-- direct `.from('listing_moderation').select(...)` call naming them
-- explicitly (Postgres raises a column-privilege error), not merely
-- hidden by happening not to appear in the view's own column list.
revoke all on public.listing_moderation from anon, authenticated;
grant select (listing_id, moderation_status, rejection_reason, moderated_at)
  on public.listing_moderation to authenticated;

create policy "listing_moderation: merchant read own"
  on public.listing_moderation for select
  to authenticated
  using (
    exists (
      select 1 from public.listings l
      where l.id = listing_moderation.listing_id and l.merchant_id = auth.uid()
    )
  );

revoke all on public.listing_moderation_merchant_view from anon, authenticated;
create or replace view public.listing_moderation_merchant_view
with (security_invoker = true, security_barrier = true)
as
select
  lm.listing_id,
  lm.moderation_status,
  lm.rejection_reason,
  lm.moderated_at
from public.listing_moderation lm
join public.listings l on l.id = lm.listing_id
where l.merchant_id = auth.uid();

grant select on public.listing_moderation_merchant_view to authenticated;

-- ════════════════════════════════════════════════════════════════
-- 2. listing_ownership_verification_merchant_view -- CONVERTED
-- ════════════════════════════════════════════════════════════════
-- Identical finding to view 1: every direct caller of
-- `listing_ownership_verification` (admin listing detail, admin
-- listing activation, exceptions-service, merchants-service's pending
-- count, the manual ownership-verification provider) uses the
-- service-role client exclusively. provider/provider_reference/
-- reviewer_notes/reason_code/reviewed_by are deliberately never
-- granted -- only the same 4 columns the merchant view has always
-- exposed.
revoke all on public.listing_ownership_verification from anon, authenticated;
grant select (listing_id, status, merchant_feedback, reviewed_at)
  on public.listing_ownership_verification to authenticated;

create policy "listing_ownership_verification: merchant read own"
  on public.listing_ownership_verification for select
  to authenticated
  using (
    exists (
      select 1 from public.listings l
      where l.id = listing_ownership_verification.listing_id and l.merchant_id = auth.uid()
    )
  );

revoke all on public.listing_ownership_verification_merchant_view from anon, authenticated;
create or replace view public.listing_ownership_verification_merchant_view
with (security_invoker = true, security_barrier = true)
as
select
  ov.listing_id,
  ov.status,
  ov.merchant_feedback,
  ov.reviewed_at
from public.listing_ownership_verification ov
join public.listings l on l.id = ov.listing_id
where l.merchant_id = auth.uid();

grant select on public.listing_ownership_verification_merchant_view to authenticated;

-- ════════════════════════════════════════════════════════════════
-- 3. identity_verification_self_view -- CONVERTED
-- ════════════════════════════════════════════════════════════════
-- Every direct caller of `identity_verifications` (admin verification
-- list/detail, resubmit's own-status check, the manual provider, the
-- exceptions-service sweep, users-service) uses the service-role
-- client exclusively -- confirmed via the same repo-wide trace.
-- provider/provider_reference/reviewer_notes/reason_code/reviewed_by
-- are deliberately never granted -- only the same 14 columns the
-- self-view has always exposed.
revoke all on public.identity_verifications from anon, authenticated;
grant select (
  user_id, status, legal_first_name, legal_surname, date_of_birth,
  id_reference_type, id_reference_number, nationality, country_of_residence,
  residential_address, user_feedback, review_count, submitted_at, reviewed_at
) on public.identity_verifications to authenticated;

create policy "identity_verifications: self read own"
  on public.identity_verifications for select
  to authenticated
  using (auth.uid() = user_id);

revoke all on public.identity_verification_self_view from anon, authenticated;
create or replace view public.identity_verification_self_view
with (security_invoker = true, security_barrier = true)
as
select
  iv.user_id,
  iv.status,
  iv.legal_first_name,
  iv.legal_surname,
  iv.date_of_birth,
  iv.id_reference_type,
  iv.id_reference_number,
  iv.nationality,
  iv.country_of_residence,
  iv.residential_address,
  iv.user_feedback,
  iv.review_count,
  iv.submitted_at,
  iv.reviewed_at
from public.identity_verifications iv
where iv.user_id = auth.uid();

grant select on public.identity_verification_self_view to authenticated;

-- ════════════════════════════════════════════════════════════════
-- 4. barter_locked_listings -- RETAINED, justified definer exception
-- ════════════════════════════════════════════════════════════════
-- Exact reason security_invoker is unsafe here: answering "is this
-- listing locked" requires joining 3 strictly party-only tables
-- (barter_offer_items, barter_offers, barter_agreements). Making this
-- work under invoker semantics for a non-party/anon caller would
-- require adding a PUBLIC-readable row-visibility policy across all
-- three -- not merely a column restriction, a genuinely new ROW-level
-- exposure of every currently-locked trade's existence on tables whose
-- entire design today is strict mutual-party privacy (no public/
-- cross-party policy exists on any of them, by design, because they
-- hold real negotiation/financial content: item lists, offer status,
-- party identities). That is a materially larger, riskier, multi-table
-- widening for a lint-only gain, not a data-exposure reduction --
-- proven concretely by `search_listings` (20260902000004, SECURITY
-- INVOKER, executable by anon), whose own `not exists (select ... from
-- barter_locked_listings ...)` check depends on this view staying
-- definer-privileged; flipping it would silently stop filtering locked
-- listings out of public search for every non-party browsing
-- anonymously.
-- Exact data exposed: listing_id, agreement_id only -- both already
-- inert to a non-party (agreement_id is not independently queryable by
-- them; barter_agreements/offers/offer_items RLS blocks it).
-- Exact roles that may read it: anon, authenticated (unchanged).
-- Proof callers cannot vary the predicate: the WHERE clause is fixed
-- SQL (bo.id = ba.accepted_offer_id and status not in (...)), never
-- parameterized or caller-supplied.
-- Proof no sensitive columns are exposed: the SELECT list has never
-- contained anything beyond the two id columns (unchanged by this
-- migration).
-- A dedicated, separately-maintained lock-state table was considered
-- and rejected: it would duplicate transaction state (a second,
-- independently-written source of truth that must stay in sync with
-- barter_agreements/rent_to_buy_agreements forever, with its own drift
-- risk), which is a materially worse trade than a clearly-scoped,
-- already-narrow, already-tested definer view.
revoke all on public.barter_locked_listings from anon, authenticated;
create or replace view public.barter_locked_listings
with (security_invoker = false, security_barrier = true)
as
select boi.listing_id, ba.id as agreement_id
from public.barter_offer_items boi
join public.barter_offers bo on bo.id = boi.offer_id
join public.barter_agreements ba on ba.id = bo.agreement_id
where bo.id = ba.accepted_offer_id
  and ba.status not in ('completed', 'cancelled', 'rejected', 'expired');

grant select on public.barter_locked_listings to anon, authenticated;

-- ════════════════════════════════════════════════════════════════
-- 5. rent_to_buy_locked_listings -- RETAINED, justified definer exception
-- ════════════════════════════════════════════════════════════════
-- Same exact reasoning as view 4: `rent_to_buy_agreements` is strict
-- party-only (merchant_id/customer_id = auth.uid()), by design, and
-- holds real transactional content. A public row-visibility policy
-- would be a new, meaningful widening of that boundary for a lint-only
-- gain. Exact data exposed: listing_id, agreement_id only (unchanged).
-- Exact roles: anon, authenticated (unchanged). The WHERE predicate is
-- fixed SQL, never caller-supplied. No sensitive column has ever been
-- in the SELECT list. A duplicated lock-state table was rejected for
-- the same drift-risk reason as view 4.
revoke all on public.rent_to_buy_locked_listings from anon, authenticated;
create or replace view public.rent_to_buy_locked_listings
with (security_invoker = false, security_barrier = true)
as
select listing_id, id as agreement_id
from public.rent_to_buy_agreements
where
  status = 'completed'
  or (
    status not in ('pending_merchant_acceptance', 'cancelled')
    and possession_status not in ('returned_to_merchant', 'recovered')
  );

grant select on public.rent_to_buy_locked_listings to anon, authenticated;

-- ════════════════════════════════════════════════════════════════
-- 6. public_profiles -- RETAINED, justified definer exception
-- ════════════════════════════════════════════════════════════════
-- Exact reason security_invoker is unsafe here, decisive and specific
-- to this view (not merely "RLS is row-level"): two of its columns are
-- COMPUTED/CONDITIONAL, not a static projection --
--   is_verified          = (p.kyc_status = 'approved')
--   public_business_name = case when <plan entitles> then p.business_name else null end
-- Column-level GRANTs can only make a raw column visible or not; they
-- cannot make a column "visible only through a derived expression."
-- For an invoker view to evaluate either expression for a row that
-- isn't the caller's own, Postgres requires SELECT privilege on the
-- raw underlying column (kyc_status, business_name) for the querying
-- role -- and granting that column at all means any client can query
-- it DIRECTLY via the Data API (`/rest/v1/profiles?select=kyc_status`),
-- bypassing the derivation entirely. That would re-expose the exact
-- raw kyc_status enum (pending/rejected/none/approved) and the
-- business_name of merchants whose plan does NOT entitle them to
-- public branding -- precisely the leak 20260831000001 was written to
-- close. The lateral join to merchant_subscription_plans/
-- merchant_subscription_history would additionally require a new
-- public-readable policy on subscription-history rows for every OTHER
-- user, a genuinely new exposure surface (timing of plan changes) that
-- does not exist today. No column-grant design can thread this; it
-- would require denormalizing is_verified/public_business_name into
-- their own trigger-synced columns with their own narrow grants --
-- materially larger, new infrastructure this phase does not introduce
-- (Part K/non-goals: do not invent unnecessary infrastructure, do not
-- redesign profiles).
-- Public columns (unchanged, 0 added, 0 removed from the prior draft):
-- id, display_name, full_name, avatar_url, role, is_verified,
-- unity_score, created_at, is_elite, public_business_name.
-- full_name decision (Part D): searched every current caller --
-- listings.ts (attachMerchantIdentities/fetchPublicProfilesById),
-- orders/[id]/route.ts, dashboard/barter/[id]/page.tsx,
-- dashboard/barter/skill-task/[id]/offers/page.tsx,
-- marketing/barter/skill-task/[id]/page.tsx. Every one of the 5 uses
-- the identical fallback chain `display_name || full_name || 'Unity
-- user'`. display_name is genuinely nullable (optional at signup, from
-- raw_user_meta_data), so this fallback is load-bearing, not
-- vestigial: without it, any user who skipped setting a display name
-- would show as a generic "Unity user" to their own trade counterparty
-- on a live barter negotiation or to the author of a listing/post they
-- are viewing -- a real trust/accountability regression, not a cosmetic
-- one. full_name was also already a conscious, reviewed inclusion in
-- 20260831000001 (the same migration that otherwise significantly
-- tightened this view), not an oversight carried forward. Retained
-- unchanged, with this justification now recorded explicitly.
-- No email, phone, account_status, affiliate data, raw kyc_status, or
-- country_id is exposed, unchanged.
revoke all on public.public_profiles from anon, authenticated;
create or replace view public.public_profiles
with (security_invoker = false, security_barrier = true)
as
select
  p.id,
  p.display_name,
  p.full_name,
  p.avatar_url,
  p.role,
  (p.kyc_status = 'approved') as is_verified,
  p.unity_score,
  p.created_at,
  coalesce(plan.elite_badge_enabled, false) as is_elite,
  case when coalesce(plan.business_name_enabled, false) then p.business_name else null end as public_business_name
from public.profiles p
left join lateral (
  select msp.elite_badge_enabled, msp.business_name_enabled
  from public.merchant_subscription_plans msp
  where msp.id = coalesce(
    (
      select h.new_plan_id from public.merchant_subscription_history h
      where h.merchant_id = p.id and h.effective_at <= now()
      order by h.effective_at desc, h.created_at desc
      limit 1
    ),
    'starter'
  )
) plan on true;

grant select on public.public_profiles to anon, authenticated;

-- ════════════════════════════════════════════════════════════════
-- 7. barter_skill_task_public_posts -- RETAINED, justified definer
--    exception (reclassified -- see header note)
-- ════════════════════════════════════════════════════════════════
-- Exact reason security_invoker is unsafe here: unlike views 1-3,
-- `barter_skill_task_posts` already has a REAL, existing authenticated
-- -session caller that needs FULL-column access to its OWN row via a
-- direct table read -- src/app/[locale]/(dashboard)/dashboard/barter/
-- skill-task/[id]/edit/page.tsx line 29:
--   supabase.from('barter_skill_task_posts').select('*')
--     .eq('id', id).eq('owner_id', requester.userId)
-- (the session client, not service_role), which needs status,
-- pre_suspend_status, transaction_type, updated_at,
-- reposted_from_post_id, first_published_at, is_test -- every column
-- the public view deliberately excludes. Column-level GRANTs are
-- scoped per ROLE, not per matching RLS policy -- there is no Postgres
-- mechanism to grant `authenticated` the full column set for the
-- existing "owner read" policy's rows while granting a narrower subset
-- for the new "public read eligible" policy's rows on the SAME role.
-- The grant must be the union, which means EITHER (a) keep it full,
-- and a public-read RLS policy would then let any OTHER authenticated
-- user see those same excluded columns on someone else's eligible
-- post too -- failing the explicit required proof in Part G ("prove
-- excluded columns remain inaccessible") -- or (b) narrow the grant to
-- the public-safe subset, which breaks the owner's own existing
-- edit-draft flow (a `select('*')` against status, etc. would start
-- failing with a column-privilege error for every user, every time
-- they open their own draft to edit it). Option (b) violates this
-- migration's own priority order at position 2 ("preserve required
-- functionality"), which is explicitly ranked above position 5
-- ("reduce advisor findings"); option (a) violates position 1
-- ("prevent unauthorized data access"). Retaining the definer view
-- avoids both: the view's own fixed column list is the only public
-- read path, entirely independent of whatever columns `authenticated`
-- holds on the base table for the owner's own full-row use case.
-- Exact data exposed: unchanged, the same 26-column safe projection
-- (id, owner_id, kind, direction, title, description, category_id,
-- subcategory_id, delivery_mode, province, city, exclusions,
-- materials_arrangement, evidence_expectations, desired_exchange_notes,
-- wants_item, wants_skill, wants_task, wants_cash_adjustment,
-- availability_notes, preferred_start_date, preferred_start_time,
-- deadline, expected_duration_notes, created_at, search_vector) --
-- status/pre_suspend_status/suspended_by/transaction_type/is_test/
-- moderation metadata remain excluded. The WHERE predicate is fixed
-- SQL, never caller-supplied.
revoke all on public.barter_skill_task_public_posts from anon, authenticated;
create or replace view public.barter_skill_task_public_posts
with (security_invoker = false, security_barrier = true)
as
select
  id, owner_id, kind, direction, title, description, category_id, subcategory_id,
  delivery_mode, province, city, exclusions, materials_arrangement, evidence_expectations,
  desired_exchange_notes, wants_item, wants_skill, wants_task, wants_cash_adjustment,
  availability_notes, preferred_start_date, preferred_start_time, deadline, expected_duration_notes,
  created_at, search_vector
from public.barter_skill_task_posts
where is_test = false
  and (
    (direction = 'available' and status = 'active')
    or (direction = 'looking_for' and status in ('active', 'offers_received'))
  );

grant select on public.barter_skill_task_public_posts to anon, authenticated;

-- ════════════════════════════════════════════════════════════════
-- 8. ad_packages_public -- CONVERTED to security_invoker
-- ════════════════════════════════════════════════════════════════
-- `ad_packages` is a pure commercial catalog table (package name,
-- placement taxonomy, list price, quota) with no PII and no
-- party-privacy concern. Its only direct-table caller anywhere in the
-- repo (src/app/api/admin/advertising/packages/route.ts) uses the
-- service-role client exclusively -- no authenticated-session caller
-- needs any column beyond what the public view has always exposed, so
-- there is no analogue to view 7's blocking caller here. created_by
-- (an internal admin profile id), is_test, is_active, and updated_at
-- are deliberately never granted -- only the same 11 columns the view
-- has always exposed.
revoke all on public.ad_packages from anon, authenticated;
grant select (
  id, name, inventory_class, placement_type, placement_tier, position_band,
  price_cents, currency, impression_quota, commercial_version, created_at
) on public.ad_packages to anon, authenticated;

create policy "ad_packages: public read active"
  on public.ad_packages for select
  to anon, authenticated
  using (is_active = true and is_test = false);

revoke all on public.ad_packages_public from anon, authenticated;
create or replace view public.ad_packages_public
with (security_invoker = true, security_barrier = true)
as
select id, name, inventory_class, placement_type, placement_tier, position_band,
       price_cents, currency, impression_quota, commercial_version, created_at
from public.ad_packages
where is_active = true and is_test = false;

grant select on public.ad_packages_public to anon, authenticated;
