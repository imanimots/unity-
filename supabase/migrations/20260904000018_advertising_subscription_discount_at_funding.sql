-- Advertising MVP -- subscription discount actually applied at funding.
--
-- PROVEN GAP (diagnosis phase): create_ad_campaign_draft() correctly
-- computes and snapshots snapshot_discount_bps/snapshot_discount_cents
-- at draft time, but fund_ad_campaign() never reads them -- it charges
-- the provider, requires the verified settlement, debits the balance,
-- and records ad_campaign_funding.amount_cents all using the package's
-- FULL undiscounted price. Live proof: Pro (5%) and Elite (10%)
-- merchants were charged 100% of the package price at every funding
-- event, regardless of plan.
--
-- LOCKED PRODUCT DECISION (binding remediation brief): the applicable
-- discount is resolved from the merchant's CURRENT EFFECTIVE
-- subscription plan AT FUNDING TIME (not the plan in effect when the
-- draft was created) -- matching how base package price already works
-- (current-price-at-funding, established by the prior settlement-
-- integrity migration). A plan change between draft and funding simply
-- changes which discount applies; a PENDING plan change that has not
-- yet become effective does not affect funding yet -- this is exactly
-- _get_effective_merchant_plan_id()'s own existing semantics, reused
-- verbatim, not reimplemented.
--
-- Historical data: this migration touches no existing row. Every
-- already-funded campaign's ad_campaign_funding/ad_campaigns snapshot
-- values remain exactly as originally recorded -- the new pricing
-- authority applies only to funding events that happen after this
-- migration is applied.

-- ── _ad_resolve_discount ── single canonical discount formula ─────────
-- Called from both the funding-quote RPC (so the route knows what to
-- charge the provider) and fund_ad_campaign() itself (so the actual
-- charge is validated against the identical formula) -- one source of
-- truth, never duplicated in application code. Deterministic integer-
-- cents arithmetic only: discount_cents = floor(base * bps / 10000),
-- matching the exact formula already established by
-- create_ad_campaign_draft() (20260819072044) -- not invented here.
create or replace function public._ad_resolve_discount(p_base_price_cents integer, p_owner_profile_id uuid)
returns table (plan_id text, discount_bps integer, discount_cents integer, final_amount_cents integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan_id text;
  v_discount_bps integer;
  v_discount_cents integer;
begin
  v_plan_id := public._get_effective_merchant_plan_id(p_owner_profile_id);
  select advertising_discount_bps into v_discount_bps from public.merchant_subscription_plans where id = v_plan_id;
  v_discount_bps := coalesce(v_discount_bps, 0);
  v_discount_cents := (p_base_price_cents * v_discount_bps) / 10000;

  return query select v_plan_id, v_discount_bps, v_discount_cents, p_base_price_cents - v_discount_cents;
end;
$$;

revoke all on function public._ad_resolve_discount(integer, uuid) from public, anon, authenticated;
grant execute on function public._ad_resolve_discount(integer, uuid) to service_role;

-- ── get_ad_campaign_funding_quote ── route-facing canonical quote ─────
-- The funding route calls this BEFORE charging the provider, so the
-- amount it charges externally is derived from the exact same formula
-- fund_ad_campaign() will independently re-verify at commit time --
-- never a separately-implemented TypeScript formula. This is a plain
-- read (no row lock) since it is immediately superseded by
-- fund_ad_campaign()'s own locked re-validation; if the package price or
-- effective plan changes between this quote and the actual funding call,
-- fund_ad_campaign()'s fresh computation will simply disagree with the
-- settlement's amount and funding is rejected -- fail closed, not
-- papered over, matching the existing settlement-amount-mismatch
-- behavior already proven for package-price races.
create or replace function public.get_ad_campaign_funding_quote(p_actor_profile_id uuid, p_campaign_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_campaign public.ad_campaigns;
  v_advertiser public.ad_advertisers;
  v_package public.ad_packages;
  v_discount record;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;

  select * into v_campaign from public.ad_campaigns where id = p_campaign_id;
  if not found then
    raise exception 'campaign not found';
  end if;

  select * into v_advertiser from public.ad_advertisers where id = v_campaign.advertiser_id;
  if v_advertiser.owner_profile_id <> p_actor_profile_id then
    raise exception 'not authorized: caller does not own this campaign';
  end if;

  select * into v_package from public.ad_packages where id = v_campaign.package_id;
  if not found then
    raise exception 'package not found';
  end if;

  select * into v_discount from public._ad_resolve_discount(v_package.price_cents, v_advertiser.owner_profile_id);

  return jsonb_build_object(
    'campaign_id', v_campaign.id,
    'base_price_cents', v_package.price_cents,
    'currency', v_package.currency,
    'plan_id', v_discount.plan_id,
    'discount_bps', v_discount.discount_bps,
    'discount_cents', v_discount.discount_cents,
    'final_amount_cents', v_discount.final_amount_cents,
    'is_test', v_campaign.is_test
  );
end;
$$;

revoke all on function public.get_ad_campaign_funding_quote(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_ad_campaign_funding_quote(uuid, uuid) to service_role;

-- ── fund_ad_campaign ── now discount-aware. Same signature as
-- 20260904000016 (no client-facing shape change), so a plain
-- CREATE OR REPLACE is correct -- this is a body-only change. True
-- superset of the live body immediately preceding this migration
-- (fetched from 20260904000016, the only migration that has ever
-- defined this function since the settlement-authority hardening):
-- every existing check (ownership, advertiser status, draft-only,
-- idempotency, package lock/active, settlement authority checks,
-- single-consumption, live-eligibility gate) is preserved byte-for-byte;
-- the only changes are (1) resolving v_discount once, right after the
-- package lock, and (2) using v_discount.final_amount_cents everywhere
-- v_package.price_cents was previously used as the CHARGED amount --
-- v_package.price_cents remains the base-price authority (still re-
-- locked, still what changes under a package-price race), it is simply
-- no longer the amount actually charged.
create or replace function public.fund_ad_campaign(
  p_actor_profile_id uuid,
  p_campaign_id uuid,
  p_funding_source ad_funding_source,
  p_settlement_id uuid default null,
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
  v_settlement public.ad_provider_settlements;
  v_discount record;
  v_new_balance integer;
  v_new_status ad_campaign_status;
  v_provider_reference text;
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

  v_request_hash := md5(coalesce(p_campaign_id::text,'') || '|' || coalesce(p_funding_source::text,'') || '|' || coalesce(p_settlement_id::text,''));
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

  -- Re-fetch and lock the package -- still the binding BASE-price
  -- snapshot point (unchanged from the prior migration). An admin
  -- editing/deactivating the catalogue row after this moment can never
  -- rewrite this campaign's base economics.
  select * into v_package from public.ad_packages where id = v_campaign.package_id for update;
  if not found or not v_package.is_active then
    raise exception 'package is no longer available for funding';
  end if;

  -- Resolve the discount from the CURRENT EFFECTIVE plan, right now, in
  -- this same locked transaction -- the authoritative funding-time
  -- amount for both funding sources.
  select * into v_discount from public._ad_resolve_discount(v_package.price_cents, v_advertiser.owner_profile_id);

  if p_funding_source = 'balance' then
    select * into v_account from public.ad_balance_accounts where advertiser_id = v_advertiser.id for update;
    if v_account.balance_cents < v_discount.final_amount_cents then
      raise exception 'insufficient advertising balance';
    end if;
    v_new_balance := v_account.balance_cents - v_discount.final_amount_cents;

    update public.ad_balance_accounts set balance_cents = v_new_balance, updated_at = now() where id = v_account.id;

    insert into public.ad_balance_ledger (account_id, campaign_id, entry_type, amount_cents, balance_after_cents, actor_type, actor_id, idempotency_key)
    values (v_account.id, p_campaign_id, 'campaign_purchase_debit', -v_discount.final_amount_cents, v_new_balance, 'advertiser', p_actor_profile_id, p_idempotency_key);
  else
    -- Provider funding still requires a matching VERIFIED settlement --
    -- unchanged authority from 20260904000016, now validated against the
    -- DISCOUNTED final amount rather than the full package price. A
    -- full-price settlement can no longer satisfy a discounted campaign;
    -- a settlement for any other wrong amount still fails identically.
    if p_settlement_id is null then
      raise exception 'a verified provider settlement is required to fund via provider';
    end if;

    select * into v_settlement from public.ad_provider_settlements where id = p_settlement_id for update;
    if not found then
      raise exception 'settlement not found';
    end if;
    if v_settlement.advertiser_id <> v_advertiser.id then
      raise exception 'settlement does not belong to this advertiser';
    end if;
    if v_settlement.status <> 'verified' then
      raise exception 'settlement is not in a verified state';
    end if;
    if v_settlement.amount_cents <> v_discount.final_amount_cents then
      raise exception 'settlement amount does not match the campaign''s authoritative discounted price';
    end if;
    if v_settlement.currency <> v_package.currency then
      raise exception 'settlement currency does not match the campaign''s authoritative currency';
    end if;
    if v_settlement.is_test <> v_campaign.is_test then
      raise exception 'settlement test/live status does not match the campaign';
    end if;
    if exists (select 1 from public.ad_campaign_funding where settlement_id = p_settlement_id) then
      raise exception 'this settlement has already been consumed by another campaign';
    end if;

    v_provider_reference := v_settlement.provider_reference;
  end if;

  insert into public.ad_campaign_funding (campaign_id, funding_source, amount_cents, provider_reference, settlement_id)
  values (p_campaign_id, p_funding_source, v_discount.final_amount_cents, v_provider_reference, p_settlement_id);

  v_new_status := case when v_advertiser.advertiser_type = 'unity' then 'active' else 'pending_review' end;

  if v_new_status = 'active' and not public._ad_target_is_live_eligible(p_campaign_id) then
    raise exception 'campaign target is not currently eligible to serve -- cannot auto-activate';
  end if;

  -- Re-snapshot from the (locked, current) package row AND the
  -- funding-time discount resolution -- this IS the final authoritative
  -- funding snapshot. After this update, snapshot_base_price_cents /
  -- snapshot_discount_bps / snapshot_discount_cents / snapshot_price_cents
  -- / funded_amount_cents together form the immutable historical record
  -- of exactly what was charged and why -- nothing after this point
  -- (a later package-price edit, a later plan change) ever touches them
  -- again, for this campaign.
  update public.ad_campaigns set
    status = v_new_status,
    snapshot_placement_type = v_package.placement_type,
    snapshot_placement_tier = v_package.placement_tier,
    snapshot_position_band = v_package.position_band,
    snapshot_price_cents = v_discount.final_amount_cents,
    snapshot_currency = v_package.currency,
    snapshot_impression_quota = v_package.impression_quota,
    snapshot_commercial_version = v_package.commercial_version,
    snapshot_base_price_cents = v_package.price_cents,
    snapshot_discount_bps = v_discount.discount_bps,
    snapshot_discount_cents = v_discount.discount_cents,
    snapshot_subscription_plan_id = v_discount.plan_id,
    funded_amount_cents = v_discount.final_amount_cents,
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

revoke all on function public.fund_ad_campaign(uuid, uuid, ad_funding_source, uuid, text) from public, anon, authenticated;
grant execute on function public.fund_ad_campaign(uuid, uuid, ad_funding_source, uuid, text) to service_role;

-- ── get_ad_campaign_report ── surface the pricing breakdown to the UI.
-- For a still-draft campaign, returns a LIVE quote (revalidated at
-- funding time, may change if package price or plan changes before
-- funding). For any campaign that has been funded, returns the
-- IMMUTABLE historical snapshot recorded at the moment it was actually
-- funded -- never recalculated. True superset of the live body
-- (20260903000015, the only migration that has ever defined this
-- function): every existing field is unchanged; only new pricing-
-- breakdown fields are added.
create or replace function public.get_ad_campaign_report(p_actor_profile_id uuid, p_campaign_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_campaign public.ad_campaigns;
  v_served_impressions integer;
  v_estimated_reach integer;
  v_valid_clicks integer;
  v_underdelivery_credit integer;
  v_ctr numeric;
  v_quote jsonb;
  v_base_price_cents integer;
  v_discount_bps integer;
  v_discount_cents integer;
  v_plan_id text;
begin
  select * into v_campaign from public.ad_campaigns where id = p_campaign_id;
  if not found then
    raise exception 'campaign not found';
  end if;
  if not exists (select 1 from public.ad_advertisers a where a.id = v_campaign.advertiser_id and a.owner_profile_id = p_actor_profile_id) then
    if not exists (select 1 from public.profiles where id = p_actor_profile_id and role = 'admin') then
      raise exception 'not authorized';
    end if;
  end if;

  select count(*) into v_served_impressions from public.ad_impressions where campaign_id = p_campaign_id and countable = true;
  select count(distinct reach_key) into v_estimated_reach from public.ad_impressions where campaign_id = p_campaign_id and countable = true;
  select count(*) into v_valid_clicks from public.ad_clicks where campaign_id = p_campaign_id and countable = true;
  select coalesce(sum(amount_cents), 0) into v_underdelivery_credit
    from public.ad_balance_ledger where campaign_id = p_campaign_id and entry_type = 'underdelivery_credit';

  v_ctr := case when v_served_impressions > 0 then round((v_valid_clicks::numeric / v_served_impressions) * 100, 2) else 0 end;

  if v_campaign.status = 'draft' then
    v_quote := public.get_ad_campaign_funding_quote(p_actor_profile_id, p_campaign_id);
    v_base_price_cents := (v_quote->>'base_price_cents')::integer;
    v_discount_bps := (v_quote->>'discount_bps')::integer;
    v_discount_cents := (v_quote->>'discount_cents')::integer;
    v_plan_id := v_quote->>'plan_id';
  else
    v_base_price_cents := v_campaign.snapshot_base_price_cents;
    v_discount_bps := v_campaign.snapshot_discount_bps;
    v_discount_cents := v_campaign.snapshot_discount_cents;
    v_plan_id := v_campaign.snapshot_subscription_plan_id;
  end if;

  return jsonb_build_object(
    'campaign_id', v_campaign.id,
    'status', v_campaign.status,
    'placement_type', v_campaign.snapshot_placement_type,
    'placement_tier', v_campaign.snapshot_placement_tier,
    'position_band', v_campaign.snapshot_position_band,
    'activated_at', v_campaign.activated_at,
    'end_at', v_campaign.end_at,
    'completed_at', v_campaign.completed_at,
    'purchased_impressions', v_campaign.snapshot_impression_quota,
    'served_impressions', v_served_impressions,
    'estimated_reach', v_estimated_reach,
    'valid_clicks', v_valid_clicks,
    'ctr_percent', v_ctr,
    'delivered_percent', case when v_campaign.snapshot_impression_quota > 0
      then round((v_campaign.delivered_impressions::numeric / v_campaign.snapshot_impression_quota) * 100, 2) else 0 end,
    'remaining_impression_quota', greatest(v_campaign.snapshot_impression_quota - v_campaign.delivered_impressions, 0),
    'funded_amount_cents', v_campaign.funded_amount_cents,
    'currency', v_campaign.snapshot_currency,
    'underdelivery_credit_cents', v_underdelivery_credit,
    'base_price_cents', v_base_price_cents,
    'discount_bps', v_discount_bps,
    'discount_cents', v_discount_cents,
    'subscription_plan_id', v_plan_id,
    'pricing_is_live_quote', v_campaign.status = 'draft'
  );
end;
$$;

revoke all on function public.get_ad_campaign_report(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_ad_campaign_report(uuid, uuid) to service_role;
