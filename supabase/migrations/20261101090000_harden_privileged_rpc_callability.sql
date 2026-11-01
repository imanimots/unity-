-- ============================================================
-- E9 -- Privileged RPC callability & identity hardening
-- (E9-F1 correction folded in -- this migration is unapplied and
-- unpushed, so it is amended in place rather than fixed forward;
-- see the two "E9-F1 CORRECTION" notes below for what changed and why)
-- ============================================================
-- Supabase's security advisor currently reports 20 anon-executable and
-- 21 authenticated-executable SECURITY DEFINER functions. This
-- migration audits the 8 highest-value, application-callable members
-- of that set (request-controlled parameters, reachable via
-- /rest/v1/rpc/..., may mutate state or accept identity-like
-- parameters) -- not all 21/20, per this phase's own explicit scope.
--
-- Methodology for each: traced every real application caller
-- (grep across src/), the exact live EXECUTE grant history (grep
-- across every migration), and the function's own internal identity/
-- ownership checks -- decisions are based on what the code actually
-- does today, not on the function's name.
--
-- Project-wide fact discovered during this and the preceding KYC work
-- (20260909175055_fix_finalize_kyc_document_upload_grants.sql) and
-- treated as established going forward: `revoke execute ... from
-- public` alone does NOT revoke `anon`'s or `service_role`'s EXECUTE
-- on a function in this project -- Supabase's default-privilege
-- configuration grants those two roles EXECUTE directly on every new
-- function, independent of the PUBLIC pseudo-role. Every revoke below
-- names `anon`/`service_role`/`authenticated` explicitly, never relies
-- on revoking `public` alone to imply anything about them.
--
-- DISPOSITION SUMMARY
--   1. save_listing_draft -- AUTHENTICATED-SELF. Already derives the
--      acting user exclusively from auth.uid() (no identity parameter
--      exists in its signature at all) and already enforces
--      ownership/allowlisting/sanitization internally. The one real
--      gap: never received the explicit anon-revoke
--      finalize_kyc_document_upload got, plausibly the exact cause of
--      its "anon AND authenticated" advisor flag. Fixed here: explicit
--      revoke from public/anon/service_role, re-assert authenticated.
--      No body change -- its internal logic was already correct.
--   2. finalize_kyc_document_upload -- AUTHENTICATED-SELF. Already
--      correctly scoped (authenticated only; anon/service_role were
--      already explicitly revoked in 20260909175055) with solid
--      internal ownership/expiry/idempotency/storage-consistency
--      checks. NOT TOUCHED by this migration -- already a documented,
--      justified exception; there is nothing to fix.
--   3. record_ad_impression -- RECLASSIFIED to SERVER-ONLY
--      (E9-F1 CORRECTION -- see below). No longer directly
--      anon/authenticated-executable.
--   4. record_ad_click -- RECLASSIFIED to SERVER-ONLY. Its one real
--      application caller already uses service_role
--      (api/advertising/click/route.ts); no legitimate direct anon/
--      authenticated caller was found anywhere. Fixed: EXECUTE
--      narrowed to service_role only (a pure exposure reduction with
--      zero functional impact, since the real flow never used direct
--      anon/authenticated access). Also fixed: the function never
--      verified p_impression_id actually belonged to p_campaign_id (a
--      foreign-key-only check, not a campaign-linkage check) -- now
--      independently verified before any insert.
--   5. get_eligible_ads -- PUBLIC-READ, justified SECURITY DEFINER
--      exception. Its output is already a minimal, safe projection
--      (campaign id, target-type discriminator, three target ids, and
--      three creative display fields only -- no advertiser identity,
--      budget, balance, settlement state, or raw targeting data).
--      Converting to invoker would require widening RLS across
--      ad_campaigns/ad_advertisers/ad_targeting/ad_creatives/
--      ad_campaign_funding/rent_to_buy_listing_terms AND granting
--      EXECUTE on the nested _ad_target_is_live_eligible() helper
--      (currently, correctly, service_role-only) to anon/authenticated
--      -- a cascading, multi-object widening for a lint-only gain, not
--      a data-exposure reduction, exactly the pattern E8-F1 already
--      established as unsafe for an analogous case. NOT TOUCHED.
--   6-8. is_barter_contribution_participant, is_dispute_participant,
--      is_message_participant -- the "authenticated oracle" surface
--      (any authenticated caller could ask "is user X a participant
--      in object Y" for an arbitrary p_user_id) is now CLOSED
--      (E9-F1 CORRECTION -- see below), not merely documented.
--
-- E9-F1 CORRECTION 1 -- record_ad_impression (BLOCKER 1):
-- The first E9 draft kept this directly anon/authenticated-executable
-- because its one real caller (src/lib/advertising/search-insertion.ts)
-- used the session client directly, and because its own internal
-- checks (now derived from auth.uid()) seemed to close the identity-
-- spoofing angle. That missed the real issue Part A of this follow-up
-- re-traced: the function has NO effective anti-replay at all (no
-- uniqueness constraint, p_idempotency_key was accepted but never once
-- read in the body) -- any holder of an anon or authenticated JWT could
-- call it directly, repeatedly, with zero cost, to burn an advertiser's
-- delivered_impressions quota or force a campaign to 'completed'
-- early. Viewing an ad and holding direct permission to mutate
-- advertising billing state are different privileges, and the advisor
-- finding correctly treated the former as not justifying the latter.
--
-- Fix: record_ad_impression is now SERVER-ONLY (service_role only,
-- matching record_ad_click's own already-correct model). The real
-- caller (search-insertion.ts) was changed to invoke it through a
-- service-role client instead of the session client, gaining a real,
-- rate-limited, idempotency-key-generating trust boundary in front of
-- it (src/lib/advertising/search-insertion.ts, same commit). p_viewer_id
-- is trusted again as a parameter -- this is now SAFE specifically
-- because the only possible caller is the trusted service-role path,
-- which independently derives it from the visitor's own session
-- (supabase.auth.getUser()) BEFORE calling, the same "service_role +
-- already-verified identity parameter" pattern already used throughout
-- this codebase (record_ad_click, the 3 participant helpers' service
-- overload below, every Support Centre RPC). auth.uid()-derivation
-- inside the function itself (E9's original fix) is reverted, because
-- auth.uid() is always NULL under a service-role connection -- keeping
-- it would have silently broken the self-view exclusion feature for
-- every real caller once EXECUTE was narrowed.
--
-- A genuine, DB-enforced idempotency boundary was added using this
-- project's own established pattern (ad_clicks_idempotency_idx):
-- ad_impressions gains an idempotency_key column and a matching
-- partial unique index; the function checks for an existing
-- (campaign_id, idempotency_key) row AFTER acquiring the campaign's
-- own `for update` row lock (not before), so two concurrent calls
-- sharing both values are serialized by that lock rather than racing
-- a bare pre-lock SELECT. Per this phase's own explicit warning, a
-- freely client-chosen idempotency key is not replay protection by
-- itself (a caller could simply mint a fresh one per call) -- the
-- actual boundary is that only the trusted application path may call
-- this function at all, and it alone decides when to mint a new key
-- (once per genuine serving decision). The pre-existing lack of
-- anti-replay on `reach_key` is unaffected and intentionally left as
-- the pure "distinct reach" analytics signal it already was -- it was
-- never the enforcement mechanism and is not being made into one here
-- (reusing it as a quota-dedup key would silently cap a real,
-- returning signed-in viewer to one countable impression ever per
-- campaign, a product-semantics change this phase has no authority to
-- make unilaterally).
--
-- E9-F1 CORRECTION 2 -- participant helpers (BLOCKER 2):
-- E9 kept `authenticated` EXECUTE on the two-argument
-- is_*_participant(resource_id, p_user_id) overloads because RLS
-- policies depend on EXECUTE being held by the querying role, and
-- revoking it outright would have broken real participants' reads.
-- That left a residual gap: any authenticated caller could invoke the
-- RPC directly with an ARBITRARY p_user_id, not just their own,
-- learning "is user X a participant in object Y" for any resource id
-- they know -- a cross-user disclosure oracle, independent of whether
-- they themselves have any relationship to the object.
--
-- Fix: each function gains a NEW one-argument overload
-- (resource_id only) that derives the subject from auth.uid()
-- internally instead of accepting it as a parameter -- granted to
-- `authenticated` only. Every one of the 6 dependent RLS policies is
-- updated in this same migration to call the new one-argument
-- overload instead of passing auth.uid() as a second argument to the
-- old one. The original two-argument overload is KEPT (not dropped)
-- -- it is still genuinely required by the 3 service-role application
-- routes (barter milestone evidence, dispute evidence, message
-- attachments), each of which independently verifies a specific
-- user's identity via a separate session check BEFORE calling it with
-- service_role, where auth.uid() is always NULL and so could never
-- substitute for the explicit parameter -- but its EXECUTE is now
-- narrowed to service_role only, closing the oracle entirely: no
-- authenticated caller can reach the two-argument form anymore, and
-- the one-argument form it's replaced with for RLS cannot accept an
-- arbitrary subject at all. Both overloads are explicitly listed in
-- Postgres's catalog as distinct functions (same name, different
-- arity) -- this is standard, supported overloading, not a renamed or
-- duplicated function.
--
-- Priority order followed throughout (same as E8-F1):
--   1. Prevent unauthorized data access
--   2. Preserve required functionality
--   3. Apply RLS/identity checks at the correct trust boundary
--   4. Minimize direct EXECUTE grants
--   5. Reduce advisor findings
-- ============================================================

-- ════════════════════════════════════════════════════════════════
-- 1. save_listing_draft -- grants only, no body change
-- ════════════════════════════════════════════════════════════════
revoke all on function public.save_listing_draft(uuid, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, text)
  from public, anon, service_role;
grant execute on function public.save_listing_draft(uuid, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, text)
  to authenticated;

-- ════════════════════════════════════════════════════════════════
-- 2. finalize_kyc_document_upload -- NOT TOUCHED (already correct)
-- ════════════════════════════════════════════════════════════════

-- ════════════════════════════════════════════════════════════════
-- 3. record_ad_impression -- schema + body + grants (see E9-F1
--    CORRECTION 1 above for the full rationale)
-- ════════════════════════════════════════════════════════════════
alter table public.ad_impressions add column if not exists idempotency_key text;

create unique index if not exists ad_impressions_idempotency_idx
  on public.ad_impressions(campaign_id, idempotency_key)
  where idempotency_key is not null;

create or replace function public.record_ad_impression(
  p_campaign_id uuid,
  p_placement_type ad_placement_type,
  p_viewer_id uuid default null,
  p_reach_key text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_campaign public.ad_campaigns;
  v_advertiser public.ad_advertisers;
  v_existing public.ad_impressions;
  v_countable boolean := true;
  v_exclusion text := null;
  v_impression_id uuid;
  v_new_delivered integer;
begin
  if p_reach_key is null or char_length(trim(p_reach_key)) = 0 then
    raise exception 'reach_key is required';
  end if;

  select * into v_campaign from public.ad_campaigns where id = p_campaign_id for update;
  if not found then
    return jsonb_build_object('recorded', false, 'reason', 'campaign_not_found');
  end if;

  -- Idempotency check happens AFTER acquiring the campaign row lock
  -- above, so two concurrent calls sharing both p_campaign_id and
  -- p_idempotency_key are serialized by that lock rather than racing a
  -- bare pre-lock SELECT -- by the time a second, blocked caller's lock
  -- is granted, the first caller's insert (if any) has already
  -- committed and is visible here.
  if p_idempotency_key is not null then
    select * into v_existing from public.ad_impressions where campaign_id = p_campaign_id and idempotency_key = p_idempotency_key;
    if found then
      return jsonb_build_object('recorded', true, 'impression_id', v_existing.id, 'countable', v_existing.countable);
    end if;
  end if;

  select * into v_advertiser from public.ad_advertisers where id = v_campaign.advertiser_id;

  if v_campaign.status <> 'active' then
    return jsonb_build_object('recorded', false, 'reason', 'not_active');
  end if;
  if v_campaign.delivered_impressions >= v_campaign.snapshot_impression_quota then
    return jsonb_build_object('recorded', false, 'reason', 'quota_exhausted');
  end if;
  if v_campaign.end_at is not null and v_campaign.end_at <= now() then
    return jsonb_build_object('recorded', false, 'reason', 'end_date_passed');
  end if;

  -- Self-view exclusion: p_viewer_id is trusted here because this
  -- function's ONLY caller (after the grant below) is the trusted
  -- service-role application path, which independently derives it
  -- from the visitor's own session before calling.
  if p_viewer_id is not null and p_viewer_id = v_advertiser.owner_profile_id then
    v_countable := false;
    v_exclusion := 'self_view';
  end if;

  insert into public.ad_impressions (campaign_id, placement_type, viewer_id, reach_key, countable, exclusion_reason, idempotency_key)
  values (p_campaign_id, p_placement_type, p_viewer_id, p_reach_key, v_countable, v_exclusion, p_idempotency_key)
  returning id into v_impression_id;

  if v_countable then
    v_new_delivered := v_campaign.delivered_impressions + 1;
    update public.ad_campaigns set delivered_impressions = v_new_delivered, last_served_at = now(), updated_at = now()
    where id = p_campaign_id;

    if v_new_delivered >= v_campaign.snapshot_impression_quota then
      update public.ad_campaigns set status = 'completed', completion_reason = 'quota_reached', completed_at = now(), updated_at = now()
      where id = p_campaign_id;
      insert into public.ad_campaign_history (campaign_id, actor_type, action_type, previous_status, new_status, reason)
      values (p_campaign_id, 'system', 'quota_reached', 'active', 'completed', 'impression quota fully delivered');
    end if;
  else
    update public.ad_campaigns set last_served_at = now(), updated_at = now() where id = p_campaign_id;
  end if;

  return jsonb_build_object('recorded', true, 'impression_id', v_impression_id, 'countable', v_countable);
end;
$$;

revoke all on function public.record_ad_impression(uuid, ad_placement_type, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.record_ad_impression(uuid, ad_placement_type, uuid, text, text)
  to service_role;

-- ════════════════════════════════════════════════════════════════
-- 4. record_ad_click -- body change: verify p_impression_id actually
--    belongs to p_campaign_id before trusting the linkage (previously
--    only a bare foreign-key existence check, from any campaign).
--    Every other line is unchanged from 20260903000013's body.
-- ════════════════════════════════════════════════════════════════
create or replace function public.record_ad_click(
  p_campaign_id uuid,
  p_impression_id uuid default null,
  p_viewer_id uuid default null,
  p_reach_key text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_campaign public.ad_campaigns;
  v_advertiser public.ad_advertisers;
  v_creative public.ad_creatives;
  v_existing public.ad_clicks;
  v_is_self boolean := false;
  v_click_id uuid;
  v_destination text;
  v_destination_type text;
begin
  select * into v_campaign from public.ad_campaigns where id = p_campaign_id;
  if not found then
    raise exception 'campaign not found';
  end if;
  select * into v_advertiser from public.ad_advertisers where id = v_campaign.advertiser_id;

  -- E9: previously, only the ad_clicks.impression_id -> ad_impressions.id
  -- foreign key was enforced -- any EXISTING impression row, from ANY
  -- campaign, would pass. A caller could attach a click to an
  -- unrelated campaign's impression. Now independently verified
  -- before any insert, failing closed with zero mutation.
  if p_impression_id is not null then
    if not exists (
      select 1 from public.ad_impressions
      where id = p_impression_id and campaign_id = p_campaign_id
    ) then
      raise exception 'impression does not belong to this campaign';
    end if;
  end if;

  -- Idempotent replay: the same client-issued key returns the same
  -- destination without inserting a second click row.
  if p_idempotency_key is not null then
    select * into v_existing from public.ad_clicks where campaign_id = p_campaign_id and idempotency_key = p_idempotency_key;
    if found then
      v_click_id := v_existing.id;
    end if;
  end if;

  if p_viewer_id is not null and p_viewer_id = v_advertiser.owner_profile_id then
    v_is_self := true;
  end if;

  if v_click_id is null then
    insert into public.ad_clicks (campaign_id, impression_id, viewer_id, reach_key, is_self_click, countable, idempotency_key)
    values (p_campaign_id, p_impression_id, p_viewer_id, coalesce(p_reach_key, 'unknown'), v_is_self, not v_is_self, p_idempotency_key)
    returning id into v_click_id;
  end if;

  -- Resolve the destination server-side so the client never supplies
  -- (and cannot tamper with) a redirect target directly.
  if v_campaign.target_type = 'external' then
    select * into v_creative from public.ad_creatives where campaign_id = p_campaign_id;
    v_destination := v_creative.destination_url;
    v_destination_type := 'external';
  elsif v_campaign.target_type = 'listing' then
    v_destination := '/listings/' || v_campaign.listing_id::text;
    v_destination_type := 'internal';
  elsif v_campaign.target_type = 'marketplace_request' then
    v_destination := '/looking-for/' || v_campaign.marketplace_request_id::text;
    v_destination_type := 'internal';
  else
    v_destination := '/barter/skill-task/' || v_campaign.barter_skill_task_post_id::text;
    v_destination_type := 'internal';
  end if;

  return jsonb_build_object('click_id', v_click_id, 'destination_url', v_destination, 'destination_type', v_destination_type);
end;
$$;

-- RECLASSIFIED to SERVER-ONLY: the only real application caller
-- (src/app/api/advertising/click/route.ts) already uses service_role;
-- no legitimate direct anon/authenticated caller exists anywhere in
-- the repo. This is a pure exposure reduction with zero functional
-- impact on the real, already-service_role-routed flow.
revoke all on function public.record_ad_click(uuid, uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.record_ad_click(uuid, uuid, uuid, text, text)
  to service_role;

-- ════════════════════════════════════════════════════════════════
-- 5. get_eligible_ads -- NOT TOUCHED (already minimal output, justified
--    SECURITY DEFINER exception -- see header note)
-- ════════════════════════════════════════════════════════════════

-- ════════════════════════════════════════════════════════════════
-- 6. is_barter_contribution_participant -- new auth.uid()-deriving
--    one-argument overload for RLS; old two-argument overload narrowed
--    to service_role only (see E9-F1 CORRECTION 2 above)
-- ════════════════════════════════════════════════════════════════
create or replace function public.is_barter_contribution_participant(p_offer_item_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
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

revoke all on function public.is_barter_contribution_participant(uuid) from public, anon;
grant execute on function public.is_barter_contribution_participant(uuid) to authenticated;

-- Old two-argument form -- still required by
-- src/app/api/barter/[id]/milestones/[milestoneId]/evidence/route.ts
-- (service_role, checking an already-session-verified subject), where
-- auth.uid() is always NULL and so cannot substitute for the explicit
-- parameter. Narrowed to service_role only -- no authenticated caller
-- can reach this overload anymore.
revoke all on function public.is_barter_contribution_participant(uuid, uuid) from public, anon, authenticated;
grant execute on function public.is_barter_contribution_participant(uuid, uuid) to service_role;

drop policy if exists "barter_contribution_details: participants read" on public.barter_contribution_details;
create policy "barter_contribution_details: participants read"
  on public.barter_contribution_details for select
  using (public.is_barter_contribution_participant(offer_item_id));

drop policy if exists "barter_contribution_milestones: participants read" on public.barter_contribution_milestones;
create policy "barter_contribution_milestones: participants read"
  on public.barter_contribution_milestones for select
  using (public.is_barter_contribution_participant(offer_item_id));

drop policy if exists "barter_milestone_evidence: participants read" on public.barter_milestone_evidence;
create policy "barter_milestone_evidence: participants read"
  on public.barter_milestone_evidence for select
  using (public.is_barter_contribution_participant(
    (select offer_item_id from public.barter_contribution_milestones where id = milestone_id)
  ));

-- ════════════════════════════════════════════════════════════════
-- 7. is_dispute_participant -- same pattern as function 6
-- ════════════════════════════════════════════════════════════════
create or replace function public.is_dispute_participant(p_dispute_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
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

revoke all on function public.is_dispute_participant(uuid) from public, anon;
grant execute on function public.is_dispute_participant(uuid) to authenticated;

-- Old two-argument form -- still required by
-- src/app/api/disputes/[id]/evidence/route.ts (service_role, checking
-- an already-session-verified subject). Narrowed to service_role only.
revoke all on function public.is_dispute_participant(uuid, uuid) from public, anon, authenticated;
grant execute on function public.is_dispute_participant(uuid, uuid) to service_role;

drop policy if exists "dispute_history: parties read" on public.dispute_history;
create policy "dispute_history: parties read"
  on public.dispute_history for select
  using (public.is_dispute_participant(dispute_id));

drop policy if exists "dispute_evidence: parties read" on public.dispute_evidence;
create policy "dispute_evidence: parties read"
  on public.dispute_evidence for select
  using (public.is_dispute_participant(dispute_id));

-- ════════════════════════════════════════════════════════════════
-- 8. is_message_participant -- same pattern as functions 6/7
-- ════════════════════════════════════════════════════════════════
create or replace function public.is_message_participant(p_message_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
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

revoke all on function public.is_message_participant(uuid) from public, anon;
grant execute on function public.is_message_participant(uuid) to authenticated;

-- Old two-argument form -- still required by
-- src/app/api/messages/[id]/attachments/route.ts (service_role,
-- checking an already-session-verified subject). Narrowed to
-- service_role only.
revoke all on function public.is_message_participant(uuid, uuid) from public, anon, authenticated;
grant execute on function public.is_message_participant(uuid, uuid) to service_role;

drop policy if exists "message_attachments: parties read" on public.message_attachments;
create policy "message_attachments: parties read"
  on public.message_attachments for select
  using (public.is_message_participant(message_id));
