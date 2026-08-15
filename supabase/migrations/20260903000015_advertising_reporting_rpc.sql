-- Advertising MVP -- Phase 15: advertiser-facing aggregate reporting.
--
-- ad_impressions/ad_clicks have zero owner-read RLS policy (admin only,
-- binding §49) -- this SECURITY DEFINER function is the ONLY way an
-- advertiser ever learns anything derived from those tables, and it
-- returns aggregate counts exclusively. No raw event row, no viewer_id,
-- no reach_key, no individual click/impression timestamp ever leaves
-- this function.

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
    'underdelivery_credit_cents', v_underdelivery_credit
  );
end;
$$;

revoke all on function public.get_ad_campaign_report(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_ad_campaign_report(uuid, uuid) to service_role;
