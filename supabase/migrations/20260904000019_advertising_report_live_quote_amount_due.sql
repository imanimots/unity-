-- Advertising MVP -- fix-forward correction to 20260904000018's
-- get_ad_campaign_report(): for a still-draft campaign, base_price_cents/
-- discount_bps/discount_cents were correctly sourced from a FRESH live
-- quote, but funded_amount_cents was left as the stale draft-time
-- snapshot (v_campaign.funded_amount_cents, set once at
-- create_ad_campaign_draft() and never touched again for an unfunded
-- campaign) -- inconsistent with the fresh numbers displayed alongside
-- it, and the exact "amount due" figure the merchant sees before
-- funding must match what fund_ad_campaign() will actually require.
-- Caught before this reached any test or UI review; no historical row
-- is touched by this migration -- this only changes what a READ RPC
-- returns for the CURRENT live state, same as 20260904000018 itself.
--
-- True superset of the live body (20260904000018, the only migration
-- that has ever defined this function): identical in every respect
-- except the final jsonb_build_object entry for 'funded_amount_cents',
-- which now uses a resolved v_amount_due variable instead of the raw
-- campaign column directly.
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
  v_amount_due integer;
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
    v_amount_due := (v_quote->>'final_amount_cents')::integer;
  else
    v_base_price_cents := v_campaign.snapshot_base_price_cents;
    v_discount_bps := v_campaign.snapshot_discount_bps;
    v_discount_cents := v_campaign.snapshot_discount_cents;
    v_plan_id := v_campaign.snapshot_subscription_plan_id;
    v_amount_due := v_campaign.funded_amount_cents;
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
    'funded_amount_cents', v_amount_due,
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
