-- Advertising MVP -- Phase 9: shared live-eligibility helper +
-- campaign draft creation + funding.
--
-- `_ad_target_is_live_eligible` is the SINGLE source of truth for
-- "may this campaign's target serve right now" -- reused identically by
-- the auto-activation path here AND the ad-serving RPC (a later
-- migration), so eligibility logic can never drift between the two call
-- sites. It checks only structural/data facts available in SQL; the
-- RENT_TO_BUY_ENABLED runtime flag itself is NOT checked here (Postgres
-- has no access to process.env) -- it is enforced at the TypeScript
-- ad-serving layer, exactly like every other RENT_TO_BUY_ENABLED gate
-- in this codebase (checked once at the route/service layer, never in
-- SQL). This function does NOT check advertiser/campaign suspension --
-- callers check that separately since some callers (e.g. funding, which
-- happens on a draft/funded campaign, not yet active) don't need it.

create or replace function public._ad_target_is_live_eligible(p_campaign_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_campaign public.ad_campaigns;
  v_ok boolean;
begin
  select * into v_campaign from public.ad_campaigns where id = p_campaign_id;
  if not found then
    return false;
  end if;

  if v_campaign.target_type = 'listing' then
    select exists (
      select 1 from public.listings l
      where l.id = v_campaign.listing_id
        and l.status = 'active'
        and l.is_test = v_campaign.is_test
        and l.direction = 'available'
        and not exists (select 1 from public.barter_locked_listings bl where bl.listing_id = l.id)
    ) into v_ok;
  elsif v_campaign.target_type = 'marketplace_request' then
    select exists (
      select 1 from public.marketplace_requests r
      where r.id = v_campaign.marketplace_request_id
        and r.is_test = v_campaign.is_test
        and r.status in ('active', 'offers_received')
    ) into v_ok;
  elsif v_campaign.target_type = 'barter_skill_task_post' then
    select exists (
      select 1 from public.barter_skill_task_posts p
      where p.id = v_campaign.barter_skill_task_post_id
        and p.is_test = v_campaign.is_test
        and ((p.direction = 'available' and p.status = 'active')
             or (p.direction = 'looking_for' and p.status in ('active', 'offers_received')))
    ) into v_ok;
  else
    -- 'external' -- no Unity marketplace target to revalidate. Creative
    -- approval + advertiser approval are checked separately by callers.
    v_ok := true;
  end if;

  return coalesce(v_ok, false);
end;
$$;

revoke all on function public._ad_target_is_live_eligible(uuid) from public, anon, authenticated;
grant execute on function public._ad_target_is_live_eligible(uuid) to service_role;

-- ── create_ad_campaign_draft ─────────────────────────────────────────
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

  -- Ownership + is_test-consistency check for Unity marketplace targets.
  -- Real (non-test) campaigns may never target is_test=true content
  -- (binding hard rule).
  if p_target_type = 'listing' then
    select exists (select 1 from public.listings where id = p_listing_id and merchant_id = p_actor_profile_id and (p_is_test or is_test = false)) into v_owns_target;
  elsif p_target_type = 'marketplace_request' then
    select exists (select 1 from public.marketplace_requests where id = p_marketplace_request_id and requester_id = p_actor_profile_id and (p_is_test or is_test = false)) into v_owns_target;
  elsif p_target_type = 'barter_skill_task_post' then
    select exists (select 1 from public.barter_skill_task_posts where id = p_barter_skill_task_post_id and owner_id = p_actor_profile_id and (p_is_test or is_test = false)) into v_owns_target;
  else
    v_owns_target := true; -- external: no Unity target to own
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
    -- Placeholder creative row so the advertiser has something to edit
    -- immediately; real content is filled in via update_ad_creative.
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

revoke all on function public.create_ad_campaign_draft(uuid, uuid, uuid, ad_campaign_target_type, uuid, uuid, uuid, timestamptz, boolean, text) from public, anon, authenticated;
grant execute on function public.create_ad_campaign_draft(uuid, uuid, uuid, ad_campaign_target_type, uuid, uuid, uuid, timestamptz, boolean, text) to service_role;

-- ── fund_ad_campaign ── the actual commercial-terms snapshot point ──
-- For a 'provider'-funded campaign, `p_provider_reference` must already
-- be a successful charge reference from the mock AdvertisingBillingProvider
-- (the TypeScript route calls the provider FIRST, then calls this RPC
-- with the resulting reference -- mirrors the existing
-- "a successful billing reference is required to upgrade" pattern in
-- request_merchant_plan_change exactly). This RPC never talks to a
-- payment provider itself.
create or replace function public.fund_ad_campaign(
  p_actor_profile_id uuid,
  p_campaign_id uuid,
  p_funding_source ad_funding_source,
  p_provider_reference text default null,
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
  v_package public.ad_packages;
  v_account public.ad_balance_accounts;
  v_new_balance integer;
  v_new_status ad_campaign_status;
  v_request_hash text;
  v_idem record;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;

  select * into v_campaign from public.ad_campaigns where id = p_campaign_id for update;
  if not found then
    raise exception 'campaign not found';
  end if;

  select * into v_advertiser from public.ad_advertisers where id = v_campaign.advertiser_id for update;
  if v_advertiser.owner_profile_id <> p_actor_profile_id then
    raise exception 'not authorized: caller does not own this campaign';
  end if;
  if v_advertiser.status in ('suspended', 'rejected') then
    raise exception 'advertiser account is not eligible to fund campaigns (status: %)', v_advertiser.status;
  end if;
  if v_campaign.status <> 'draft' then
    raise exception 'campaign is not in draft status (current: %)', v_campaign.status;
  end if;

  v_request_hash := md5(coalesce(p_campaign_id::text,'') || '|' || coalesce(p_funding_source::text,'') || '|' || coalesce(p_provider_reference,''));
  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_actor_profile_id and operation = 'fund_ad_campaign' and idempotency_key = p_idempotency_key;
    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  -- Re-fetch and lock the package -- this IS the binding commercial
  -- snapshot point (§55). An admin editing/deactivating the catalogue
  -- row after this moment can never rewrite this campaign's economics.
  select * into v_package from public.ad_packages where id = v_campaign.package_id for update;
  if not found or not v_package.is_active then
    raise exception 'package is no longer available for funding';
  end if;

  if p_funding_source = 'balance' then
    select * into v_account from public.ad_balance_accounts where advertiser_id = v_advertiser.id for update;
    if v_account.balance_cents < v_package.price_cents then
      raise exception 'insufficient advertising balance';
    end if;
    v_new_balance := v_account.balance_cents - v_package.price_cents;

    update public.ad_balance_accounts set balance_cents = v_new_balance, updated_at = now() where id = v_account.id;

    insert into public.ad_balance_ledger (account_id, campaign_id, entry_type, amount_cents, balance_after_cents, actor_type, actor_id, idempotency_key)
    values (v_account.id, p_campaign_id, 'campaign_purchase_debit', -v_package.price_cents, v_new_balance, 'advertiser', p_actor_profile_id, p_idempotency_key);
  else
    if p_provider_reference is null or char_length(trim(p_provider_reference)) = 0 then
      raise exception 'a successful billing provider reference is required to fund via provider';
    end if;
  end if;

  insert into public.ad_campaign_funding (campaign_id, funding_source, amount_cents, provider_reference)
  values (p_campaign_id, p_funding_source, v_package.price_cents, p_provider_reference);

  -- Re-snapshot from the (locked, current) package row -- the
  -- authoritative economic snapshot.
  v_new_status := case when v_advertiser.advertiser_type = 'unity' then 'active' else 'pending_review' end;

  if v_new_status = 'active' and not public._ad_target_is_live_eligible(p_campaign_id) then
    raise exception 'campaign target is not currently eligible to serve -- cannot auto-activate';
  end if;

  update public.ad_campaigns set
    status = v_new_status,
    snapshot_placement_type = v_package.placement_type,
    snapshot_placement_tier = v_package.placement_tier,
    snapshot_position_band = v_package.position_band,
    snapshot_price_cents = v_package.price_cents,
    snapshot_currency = v_package.currency,
    snapshot_impression_quota = v_package.impression_quota,
    snapshot_commercial_version = v_package.commercial_version,
    funded_amount_cents = v_package.price_cents,
    activated_at = case when v_new_status = 'active' then now() else activated_at end,
    updated_at = now()
  where id = p_campaign_id
  returning * into v_campaign;

  insert into public.ad_campaign_history (campaign_id, actor_type, actor_id, action_type, previous_status, new_status)
  values (p_campaign_id, 'advertiser', p_actor_profile_id, 'funded', 'draft', v_new_status);

  v_result := to_jsonb(v_campaign);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_actor_profile_id, 'fund_ad_campaign', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

revoke all on function public.fund_ad_campaign(uuid, uuid, ad_funding_source, text, text) from public, anon, authenticated;
grant execute on function public.fund_ad_campaign(uuid, uuid, ad_funding_source, text, text) to service_role;
