-- ============================================================
-- E15 -- Contain policy-internal definer helpers outside the Data API
-- ============================================================
-- Three functions remain in the live advisor's
-- authenticated_security_definer_function_executable findings:
-- is_barter_contribution_participant(uuid), is_dispute_participant(uuid),
-- is_message_participant(uuid) -- the one-argument, auth.uid()-deriving
-- overloads E9-F1 introduced specifically so RLS policies would never
-- have to pass an arbitrary caller-supplied subject. A fresh trace
-- before writing this migration confirms they are POLICY-ONLY:
--
--   - zero `.rpc('is_*_participant', ...)` calls exist anywhere in
--     src/ for the ONE-argument form -- the only real application
--     callers (3 routes: barter milestone evidence, dispute evidence,
--     message attachments) all call the TWO-argument form, always via
--     a service-role client, always with an already-session-verified
--     p_user_id (never auth.uid(), since service_role has no session
--     JWT). The two-argument forms are already service_role-only
--     (anon/authenticated/public explicitly revoked by E9-F1) and are
--     NOT touched by this migration at all -- they remain in `public`
--     because PostgREST's `.rpc()` call is an HTTP Data API request
--     regardless of which role's key authenticates it, so a function
--     reachable only via `.rpc()` must stay in an exposed schema no
--     matter which role calls it.
--   - the one-argument forms are called ONLY from RLS policy USING
--     clauses. RLS policy evaluation happens entirely inside Postgres
--     during query planning/execution for an ordinary table read -- it
--     is NOT a PostgREST-routed HTTP call, and does not require the
--     referenced function to live in a Data-API-exposed schema. It
--     only requires the querying role to hold EXECUTE on the function
--     and USAGE on its schema (confirmed: supabase/config.toml's
--     `[api] schemas = ["public", "graphql_public"]` -- `extensions`
--     and any other schema are reachable for ordinary SQL/role
--     privilege purposes via `extra_search_path`, but never
--     Data-API-routable unless listed in `schemas`).
--
-- Fix: move the three one-argument forms to a new, deliberately
-- NOT-Data-API-exposed schema, `private` (does not exist anywhere in
-- this project before this migration -- confirmed by a repo-wide
-- search; not added to config.toml's `[api] schemas`, so it is never
-- Data-API-routable). Every dependent RLS policy is updated to call
-- `private.is_*_participant(...)` instead of `public.is_*_participant
-- (...)`. The old public one-argument functions are then dropped
-- (no CASCADE -- every dependency was updated first, in this same
-- migration, so the drop is dependency-free). Bodies are otherwise
-- byte-for-byte unchanged from their current live definitions (every
-- table reference inside each was already fully `public.`-qualified),
-- except `search_path` moves from `public` to the empty string, since
-- nothing in any of the three bodies needs unqualified resolution of
-- anything beyond what is already explicitly schema-qualified.
--
-- All 6 dependent policies were re-verified directly against the live
-- migration source immediately before writing this one (not re-trusted
-- from an earlier, unverified claim): `20261101090000` already
-- correctly updated all 6 -- including dispute_history -- to call the
-- one-argument overload. There is no pre-existing policy defect to
-- correct here. Every DROP POLICY / CREATE POLICY pair below exists
-- solely to repoint each policy's predicate from `public.is_*_
-- participant(...)` to `private.is_*_participant(...)`, matching the
-- function's new location; the predicate itself (and its authorization
-- semantics) is unchanged.
--
-- No table grant is added or widened anywhere. No RLS authorization
-- semantics change for any of the 6 policies beyond the function
-- qualification. anon is not granted USAGE on the new schema or
-- EXECUTE on any new function -- none of the 6 dependent tables have
-- a legitimate anon-reachable read path
-- (auth.uid() is null for anon, so every one of these predicates is
-- always false for anon regardless), and E9-F1 already explicitly
-- revoked anon's EXECUTE on all three one-argument forms.
-- ============================================================

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

-- ────────────────────────────────────────────────────────────
-- is_barter_contribution_participant
-- ────────────────────────────────────────────────────────────
create or replace function private.is_barter_contribution_participant(p_offer_item_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.barter_offer_items boi
    join public.barter_offers bo on bo.id = boi.offer_id
    join public.barter_agreements ba on ba.id = bo.agreement_id
    where boi.id = p_offer_item_id
      and (ba.party_a_id = auth.uid() or ba.party_b_id = auth.uid())
  );
$$;

revoke all on function private.is_barter_contribution_participant(uuid) from public, anon;
grant execute on function private.is_barter_contribution_participant(uuid) to authenticated;

drop policy if exists "barter_contribution_details: participants read" on public.barter_contribution_details;
create policy "barter_contribution_details: participants read"
  on public.barter_contribution_details for select
  using (private.is_barter_contribution_participant(offer_item_id));

drop policy if exists "barter_contribution_milestones: participants read" on public.barter_contribution_milestones;
create policy "barter_contribution_milestones: participants read"
  on public.barter_contribution_milestones for select
  using (private.is_barter_contribution_participant(offer_item_id));

drop policy if exists "barter_milestone_evidence: participants read" on public.barter_milestone_evidence;
create policy "barter_milestone_evidence: participants read"
  on public.barter_milestone_evidence for select
  using (private.is_barter_contribution_participant(
    (select offer_item_id from public.barter_contribution_milestones where id = milestone_id)
  ));

drop function if exists public.is_barter_contribution_participant(uuid);

-- ────────────────────────────────────────────────────────────
-- is_dispute_participant
-- ────────────────────────────────────────────────────────────
create or replace function private.is_dispute_participant(p_dispute_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.disputes d
    left join public.bookings b on b.id = d.booking_id
    left join public.orders o on o.id = d.order_id
    left join public.barter_agreements ba on ba.id = d.barter_agreement_id
    left join public.rent_to_buy_agreements rtb on rtb.id = d.rent_to_buy_agreement_id
    where d.id = p_dispute_id
      and (
        d.raised_by = auth.uid()
        or b.renter_id = auth.uid() or b.merchant_id = auth.uid()
        or o.buyer_id = auth.uid() or o.seller_id = auth.uid()
        or ba.party_a_id = auth.uid() or ba.party_b_id = auth.uid()
        or rtb.merchant_id = auth.uid() or rtb.customer_id = auth.uid()
      )
  );
$$;

revoke all on function private.is_dispute_participant(uuid) from public, anon;
grant execute on function private.is_dispute_participant(uuid) to authenticated;

drop policy if exists "dispute_evidence: parties read" on public.dispute_evidence;
create policy "dispute_evidence: parties read"
  on public.dispute_evidence for select
  using (private.is_dispute_participant(dispute_id));

drop policy if exists "dispute_history: parties read" on public.dispute_history;
create policy "dispute_history: parties read"
  on public.dispute_history for select
  using (private.is_dispute_participant(dispute_id));

drop function if exists public.is_dispute_participant(uuid);

-- ────────────────────────────────────────────────────────────
-- is_message_participant
-- ────────────────────────────────────────────────────────────
create or replace function private.is_message_participant(p_message_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.messages m
    left join public.bookings b on b.id = m.booking_id
    left join public.orders o on o.id = m.order_id
    left join public.barter_agreements ba on ba.id = m.barter_agreement_id
    where m.id = p_message_id
      and (
        b.renter_id = auth.uid() or b.merchant_id = auth.uid()
        or o.buyer_id = auth.uid() or o.seller_id = auth.uid()
        or ba.party_a_id = auth.uid() or ba.party_b_id = auth.uid()
      )
  );
$$;

revoke all on function private.is_message_participant(uuid) from public, anon;
grant execute on function private.is_message_participant(uuid) to authenticated;

drop policy if exists "message_attachments: parties read" on public.message_attachments;
create policy "message_attachments: parties read"
  on public.message_attachments for select
  using (private.is_message_participant(message_id));

drop function if exists public.is_message_participant(uuid);
