-- Advertising MVP -- Phase 10: campaign lifecycle RPCs (pause / resume /
-- cancel / admin approve / admin reject / admin suspend / admin restore)
-- + one fix-forward correction to create_ad_campaign_draft.
--
-- Fix-forward (binding: "No future scheduled campaign start in MVP...
-- Advertiser chooses an arbitrary future END DATE... Campaign ends on
-- the earlier of: full impression quota delivered; selected end date
-- reached" -- this only makes sense if an end date always exists).
-- 20260903000009's create_ad_campaign_draft left p_end_at optional with
-- no validation; caught before any real campaign was ever created against
-- it. CREATE OR REPLACE with the byte-identical signature, adding the
-- required/future-date check -- 20260903000009 itself is not edited.
create or replace function public.create_ad_campaign_draft(
  p_actor_profile_id uuid,
  p_advertiser_id uuid,
  p_package_id uuid,
  p_target_type ad_campaign_target_type,
  p_listing_id uuid default null,
  p_marketplace_request_id uuid default null,
  p_barter_skill_task_post_id uuid default null,
  p_end_at timestamptz default null,
  p_is_test boolean default false,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_advertiser public.ad_advertisers;
  v_package public.ad_packages;
  v_campaign public.ad_campaigns;
  v_owns_target boolean;
  v_request_hash text;
  v_idem record;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_actor_profile_id is null then
    raise exception 'actor profile id is required';
  end if;
  if p_end_at is null or p_end_at <= now() then
    raise exception 'end_at is required and must be in the future';
  end if;

  select * into v_advertiser from public.ad_advertisers where id = p_advertiser_id;
  if not found then
    raise exception 'advertiser not found';
  end if;
  if v_advertiser.owner_profile_id <> p_actor_profile_id then
    raise exception 'not authorized: caller does not own this advertiser account';
  end if;
  if v_advertiser.status in ('suspended', 'rejected') then
    raise exception 'advertiser account is not eligible to create campaigns (status: %)', v_advertiser.status;
  end if;

  select * into v_package from public.ad_packages where id = p_package_id;
  if not found or not v_package.is_active then
    raise exception 'package is not available';
  end if;
  if v_package.inventory_class = 'unity_marketplace' and (v_advertiser.advertiser_type <> 'unity' or p_target_type = 'external') then
    raise exception 'this package requires a Unity marketplace advertiser and target';
  end if;
  if v_package.inventory_class = 'external' and (v_advertiser.advertiser_type <> 'external' or p_target_type <> 'external') then
    raise exception 'this package requires an external advertiser and target';
  end if;

  if p_target_type = 'listing' then
    select exists (select 1 from public.listings where id = p_listing_id and merchant_id = p_actor_profile_id and (p_is_test or is_test = false)) into v_owns_target;
  elsif p_target_type = 'marketplace_request' then
    select exists (select 1 from public.marketplace_requests where id = p_marketplace_request_id and requester_id = p_actor_profile_id and (p_is_test or is_test = false)) into v_owns_target;
  elsif p_target_type = 'barter_skill_task_post' then
    select exists (select 1 from public.barter_skill_task_posts where id = p_barter_skill_task_post_id and owner_id = p_actor_profile_id and (p_is_test or is_test = false)) into v_owns_target;
  else
    v_owns_target := true;
  end if;

  if not v_owns_target then
    raise exception 'target not found, not owned by caller, or is test content ineligible for a real campaign';
  end if;

  v_request_hash := md5(coalesce(p_advertiser_id::text,'') || '|' || coalesce(p_package_id::text,'') || '|' || coalesce(p_target_type::text,'') ||
    '|' || coalesce(p_listing_id::text,'') || '|' || coalesce(p_marketplace_request_id::text,'') || '|' || coalesce(p_barter_skill_task_post_id::text,'') ||
    '|' || coalesce(p_end_at::text,''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_actor_profile_id and operation = 'create_ad_campaign_draft' and idempotency_key = p_idempotency_key;
    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  insert into public.ad_campaigns (
    advertiser_id, package_id, status, target_type, listing_id, marketplace_request_id, barter_skill_task_post_id,
    snapshot_placement_type, snapshot_placement_tier, snapshot_position_band, snapshot_price_cents, snapshot_currency,
    snapshot_impression_quota, snapshot_commercial_version, funded_amount_cents, end_at, is_test
  ) values (
    p_advertiser_id, p_package_id, 'draft', p_target_type, p_listing_id, p_marketplace_request_id, p_barter_skill_task_post_id,
    v_package.placement_type, v_package.placement_tier, v_package.position_band, v_package.price_cents, v_package.currency,
    v_package.impression_quota, v_package.commercial_version, v_package.price_cents, p_end_at, p_is_test
  ) returning * into v_campaign;

  insert into public.ad_campaign_history (campaign_id, actor_type, actor_id, action_type, previous_status, new_status)
  values (v_campaign.id, 'advertiser', p_actor_profile_id, 'created', null, 'draft');

  insert into public.ad_targeting (campaign_id) values (v_campaign.id);

  if p_target_type = 'external' then
    insert into public.ad_creatives (campaign_id, headline, cta_text, destination_url)
    values (v_campaign.id, 'Draft headline', 'Learn more', 'https://example.invalid/draft');
  end if;

  v_result := to_jsonb(v_campaign);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_actor_profile_id, 'create_ad_campaign_draft', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

-- ── shared refund helper ── returns funded amount to its original
-- funding source. Used by both cancel (pre-activation) and admin-reject.
create or replace function public._ad_refund_campaign_funding(p_campaign_id uuid, p_actor_type text, p_actor_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_funding public.ad_campaign_funding;
  v_campaign public.ad_campaigns;
  v_account public.ad_balance_accounts;
  v_new_balance integer;
begin
  select * into v_funding from public.ad_campaign_funding where campaign_id = p_campaign_id for update;
  if not found or v_funding.status = 'refunded' then
    return; -- nothing to refund (draft never funded, or already refunded -- idempotent no-op)
  end if;

  select * into v_campaign from public.ad_campaigns where id = p_campaign_id;

  if v_funding.funding_source = 'balance' then
    select * into v_account from public.ad_balance_accounts where advertiser_id = v_campaign.advertiser_id for update;
    v_new_balance := v_account.balance_cents + v_funding.amount_cents;
    update public.ad_balance_accounts set balance_cents = v_new_balance, updated_at = now() where id = v_account.id;
    insert into public.ad_balance_ledger (account_id, campaign_id, entry_type, amount_cents, balance_after_cents, actor_type, actor_id, reason)
    values (v_account.id, p_campaign_id, 'preactivation_refund_to_balance', v_funding.amount_cents, v_new_balance, p_actor_type, p_actor_id, p_reason);
  end if;
  -- 'provider'-funded refunds are recorded here; the actual mock-provider
  -- refund call happens at the TypeScript orchestration layer around
  -- this RPC (same split-responsibility convention as funding itself --
  -- this RPC never talks to a payment provider directly).

  update public.ad_campaign_funding set status = 'refunded', refunded_at = now(), refund_reason = p_reason where campaign_id = p_campaign_id;
end;
$$;

revoke all on function public._ad_refund_campaign_funding(uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public._ad_refund_campaign_funding(uuid, text, uuid, text) to service_role;

-- ── pause_ad_campaign ─────────────────────────────────────────────────
create or replace function public.pause_ad_campaign(p_actor_profile_id uuid, p_campaign_id uuid, p_idempotency_key text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_campaign public.ad_campaigns;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;

  select * into v_campaign from public.ad_campaigns where id = p_campaign_id for update;
  if not found then
    raise exception 'campaign not found';
  end if;
  if not exists (select 1 from public.ad_advertisers a where a.id = v_campaign.advertiser_id and a.owner_profile_id = p_actor_profile_id) then
    raise exception 'not authorized: caller does not own this campaign';
  end if;
  if v_campaign.status = 'paused' then
    return to_jsonb(v_campaign); -- idempotent no-op
  end if;
  if v_campaign.status <> 'active' then
    raise exception 'campaign is not active (current: %)', v_campaign.status;
  end if;

  update public.ad_campaigns set status = 'paused', updated_at = now() where id = p_campaign_id returning * into v_campaign;
  insert into public.ad_campaign_history (campaign_id, actor_type, actor_id, action_type, previous_status, new_status)
  values (p_campaign_id, 'advertiser', p_actor_profile_id, 'paused', 'active', 'paused');

  return to_jsonb(v_campaign);
end;
$$;

revoke all on function public.pause_ad_campaign(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.pause_ad_campaign(uuid, uuid, text) to service_role;

-- ── resume_ad_campaign ────────────────────────────────────────────────
create or replace function public.resume_ad_campaign(p_actor_profile_id uuid, p_campaign_id uuid, p_idempotency_key text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_campaign public.ad_campaigns;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;

  select * into v_campaign from public.ad_campaigns where id = p_campaign_id for update;
  if not found then
    raise exception 'campaign not found';
  end if;
  if not exists (select 1 from public.ad_advertisers a where a.id = v_campaign.advertiser_id and a.owner_profile_id = p_actor_profile_id) then
    raise exception 'not authorized: caller does not own this campaign';
  end if;
  if v_campaign.status = 'active' then
    return to_jsonb(v_campaign);
  end if;
  if v_campaign.status <> 'paused' then
    raise exception 'campaign is not paused (current: %)', v_campaign.status;
  end if;
  if v_campaign.end_at is not null and v_campaign.end_at <= now() then
    raise exception 'campaign end date has already passed';
  end if;
  if not public._ad_target_is_live_eligible(p_campaign_id) then
    raise exception 'campaign target is not currently eligible to serve';
  end if;

  update public.ad_campaigns set status = 'active', updated_at = now() where id = p_campaign_id returning * into v_campaign;
  insert into public.ad_campaign_history (campaign_id, actor_type, actor_id, action_type, previous_status, new_status)
  values (p_campaign_id, 'advertiser', p_actor_profile_id, 'resumed', 'paused', 'active');

  return to_jsonb(v_campaign);
end;
$$;

revoke all on function public.resume_ad_campaign(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.resume_ad_campaign(uuid, uuid, text) to service_role;

-- ── cancel_ad_campaign ── pre-activation = refund, post-activation = no refund of unused value ──
create or replace function public.cancel_ad_campaign(p_actor_profile_id uuid, p_campaign_id uuid, p_reason text default null, p_idempotency_key text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_campaign public.ad_campaigns;
  v_pre_activation boolean;
  v_completion_reason text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;

  select * into v_campaign from public.ad_campaigns where id = p_campaign_id for update;
  if not found then
    raise exception 'campaign not found';
  end if;
  if not exists (select 1 from public.ad_advertisers a where a.id = v_campaign.advertiser_id and a.owner_profile_id = p_actor_profile_id) then
    raise exception 'not authorized: caller does not own this campaign';
  end if;
  if v_campaign.status not in ('draft', 'funded', 'pending_review', 'active', 'paused') then
    raise exception 'campaign cannot be cancelled from status %', v_campaign.status;
  end if;

  v_pre_activation := v_campaign.activated_at is null;
  v_completion_reason := case when v_pre_activation then 'cancelled_pre_activation' else 'cancelled_post_activation' end;

  if v_pre_activation and v_campaign.status <> 'draft' then
    perform public._ad_refund_campaign_funding(p_campaign_id, 'advertiser', p_actor_profile_id, coalesce(p_reason, 'advertiser cancelled before activation'));
  end if;
  -- Post-activation voluntary cancellation: no refund of unused campaign
  -- value (binding) -- distinct from underdelivery credit, which only
  -- applies at natural campaign expiry (finalize_expired_ad_campaigns).

  update public.ad_campaigns set status = 'cancelled', completion_reason = v_completion_reason, completed_at = now(), updated_at = now()
  where id = p_campaign_id returning * into v_campaign;

  insert into public.ad_campaign_history (campaign_id, actor_type, actor_id, action_type, previous_status, new_status, reason)
  values (p_campaign_id, 'advertiser', p_actor_profile_id, 'cancelled', v_campaign.status, 'cancelled', p_reason);

  return to_jsonb(v_campaign);
end;
$$;

revoke all on function public.cancel_ad_campaign(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.cancel_ad_campaign(uuid, uuid, text, text) to service_role;

-- ── admin_approve_ad_campaign ── external campaigns only ──────────────
create or replace function public.admin_approve_ad_campaign(p_admin_id uuid, p_campaign_id uuid, p_reason text default null, p_idempotency_key text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_campaign public.ad_campaigns;
  v_creative public.ad_creatives;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if not exists (select 1 from public.profiles where id = p_admin_id and role = 'admin') then
    raise exception 'not authorized';
  end if;

  select * into v_campaign from public.ad_campaigns where id = p_campaign_id for update;
  if not found then
    raise exception 'campaign not found';
  end if;
  if v_campaign.target_type <> 'external' then
    raise exception 'only external campaigns require manual approval';
  end if;
  if v_campaign.status <> 'pending_review' then
    raise exception 'campaign is not pending review (current: %)', v_campaign.status;
  end if;

  select * into v_creative from public.ad_creatives where campaign_id = p_campaign_id;
  if not found or v_creative.moderation_status <> 'approved' then
    raise exception 'creative must be approved before the campaign can be activated';
  end if;
  if not public._ad_target_is_live_eligible(p_campaign_id) then
    raise exception 'campaign is not currently eligible to serve';
  end if;

  update public.ad_campaigns set status = 'active', activated_at = now(), updated_at = now() where id = p_campaign_id returning * into v_campaign;
  insert into public.ad_campaign_history (campaign_id, actor_type, actor_id, action_type, previous_status, new_status, reason)
  values (p_campaign_id, 'admin', p_admin_id, 'approved', 'pending_review', 'active', p_reason);

  return to_jsonb(v_campaign);
end;
$$;

revoke all on function public.admin_approve_ad_campaign(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.admin_approve_ad_campaign(uuid, uuid, text, text) to service_role;

-- ── admin_reject_ad_campaign ── full refund ────────────────────────────
create or replace function public.admin_reject_ad_campaign(p_admin_id uuid, p_campaign_id uuid, p_reason text, p_idempotency_key text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_campaign public.ad_campaigns;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if not exists (select 1 from public.profiles where id = p_admin_id and role = 'admin') then
    raise exception 'not authorized';
  end if;
  if p_reason is null or char_length(trim(p_reason)) = 0 then
    raise exception 'reason is required';
  end if;

  select * into v_campaign from public.ad_campaigns where id = p_campaign_id for update;
  if not found then
    raise exception 'campaign not found';
  end if;
  if v_campaign.status <> 'pending_review' then
    raise exception 'campaign is not pending review (current: %)', v_campaign.status;
  end if;

  perform public._ad_refund_campaign_funding(p_campaign_id, 'admin', p_admin_id, p_reason);

  update public.ad_campaigns set status = 'rejected', completion_reason = 'admin_rejected', completed_at = now(), updated_at = now()
  where id = p_campaign_id returning * into v_campaign;

  insert into public.ad_campaign_history (campaign_id, actor_type, actor_id, action_type, previous_status, new_status, reason)
  values (p_campaign_id, 'admin', p_admin_id, 'rejected', 'pending_review', 'rejected', p_reason);

  return to_jsonb(v_campaign);
end;
$$;

revoke all on function public.admin_reject_ad_campaign(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.admin_reject_ad_campaign(uuid, uuid, text, text) to service_role;

-- ── admin_suspend_ad_campaign ── no refund, reversible via admin_restore ──
create or replace function public.admin_suspend_ad_campaign(p_admin_id uuid, p_campaign_id uuid, p_reason text, p_idempotency_key text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_campaign public.ad_campaigns;
  v_previous ad_campaign_status;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if not exists (select 1 from public.profiles where id = p_admin_id and role = 'admin') then
    raise exception 'not authorized';
  end if;
  if p_reason is null or char_length(trim(p_reason)) = 0 then
    raise exception 'reason is required';
  end if;

  select * into v_campaign from public.ad_campaigns where id = p_campaign_id for update;
  if not found then
    raise exception 'campaign not found';
  end if;
  if v_campaign.status = 'suspended' then
    return to_jsonb(v_campaign); -- idempotent no-op
  end if;
  if v_campaign.status not in ('active', 'paused') then
    raise exception 'campaign cannot be suspended from status %', v_campaign.status;
  end if;

  v_previous := v_campaign.status;

  update public.ad_campaigns set status = 'suspended', updated_at = now() where id = p_campaign_id returning * into v_campaign;
  insert into public.ad_campaign_history (campaign_id, actor_type, actor_id, action_type, previous_status, new_status, reason)
  values (p_campaign_id, 'admin', p_admin_id, 'suspended', v_previous, 'suspended', p_reason);

  return to_jsonb(v_campaign);
end;
$$;

revoke all on function public.admin_suspend_ad_campaign(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.admin_suspend_ad_campaign(uuid, uuid, text, text) to service_role;

-- ── admin_restore_ad_campaign ── always restores to 'active', with a
-- fresh eligibility check -- the advertiser can manually re-pause after
-- if they want it paused (MVP simplification, documented rather than
-- silent).
create or replace function public.admin_restore_ad_campaign(p_admin_id uuid, p_campaign_id uuid, p_reason text, p_idempotency_key text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_campaign public.ad_campaigns;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if not exists (select 1 from public.profiles where id = p_admin_id and role = 'admin') then
    raise exception 'not authorized';
  end if;
  if p_reason is null or char_length(trim(p_reason)) = 0 then
    raise exception 'reason is required';
  end if;

  select * into v_campaign from public.ad_campaigns where id = p_campaign_id for update;
  if not found then
    raise exception 'campaign not found';
  end if;
  if v_campaign.status <> 'suspended' then
    raise exception 'campaign is not suspended (current: %)', v_campaign.status;
  end if;
  if v_campaign.end_at is not null and v_campaign.end_at <= now() then
    raise exception 'campaign end date has already passed';
  end if;
  if not public._ad_target_is_live_eligible(p_campaign_id) then
    raise exception 'campaign target is not currently eligible to serve';
  end if;

  update public.ad_campaigns set status = 'active', updated_at = now() where id = p_campaign_id returning * into v_campaign;
  insert into public.ad_campaign_history (campaign_id, actor_type, actor_id, action_type, previous_status, new_status, reason)
  values (p_campaign_id, 'admin', p_admin_id, 'restored', 'suspended', 'active', p_reason);

  return to_jsonb(v_campaign);
end;
$$;

revoke all on function public.admin_restore_ad_campaign(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.admin_restore_ad_campaign(uuid, uuid, text, text) to service_role;
