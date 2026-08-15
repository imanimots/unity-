-- Advertising MVP -- Phase 11: targeting update (with versioned history).
--
-- Contextual-only (binding): mode/direction/kind/category/keywords/
-- country/province/city -- no behavioral/demographic/device column
-- exists to even accept here. Keywords are bounded (<=20, each capped)
-- and normalized (trim/lowercase/dedupe) using the same shape of
-- normalization already established for Search Ranking's own query
-- normalization contract (src/lib/search/cursor.ts), applied
-- independently here -- this table is never read by, or written from,
-- any Search Ranking RPC.

create or replace function public.update_ad_targeting(
  p_actor_profile_id uuid,
  p_campaign_id uuid,
  p_mode text default null,
  p_direction text default null,
  p_kind text default null,
  p_category text default null,
  p_keywords text[] default '{}',
  p_country_id text default null,
  p_province text default null,
  p_city text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_campaign public.ad_campaigns;
  v_previous public.ad_targeting;
  v_new public.ad_targeting;
  v_clean_keywords text[];
  v_previous_json jsonb;
  v_new_json jsonb;
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
  if v_campaign.status in ('completed', 'cancelled', 'rejected') then
    raise exception 'campaign targeting cannot be changed from status %', v_campaign.status;
  end if;

  -- Normalize keywords: trim, lowercase, drop empties, cap each at 50
  -- chars, dedupe, bounded to 20 (the same ceiling as the ad_targeting
  -- CHECK constraint, enforced here too for a clean error message
  -- rather than a raw constraint-violation).
  select array_agg(distinct kw) into v_clean_keywords
  from (
    select left(lower(trim(k)), 50) as kw
    from unnest(coalesce(p_keywords, '{}')) as k
    where length(trim(k)) > 0
  ) t;
  v_clean_keywords := coalesce(v_clean_keywords, '{}');
  if array_length(v_clean_keywords, 1) > 20 then
    raise exception 'at most 20 keywords are allowed';
  end if;

  select * into v_previous from public.ad_targeting where campaign_id = p_campaign_id;
  v_previous_json := to_jsonb(v_previous);

  update public.ad_targeting set
    mode = p_mode, direction = p_direction, kind = p_kind, category = p_category,
    keywords = v_clean_keywords, country_id = p_country_id, province = p_province, city = p_city,
    updated_at = now()
  where campaign_id = p_campaign_id
  returning * into v_new;

  v_new_json := to_jsonb(v_new);

  insert into public.ad_targeting_history (campaign_id, previous_targeting, new_targeting, actor_type, actor_id)
  values (p_campaign_id, v_previous_json, v_new_json, 'advertiser', p_actor_profile_id);

  return v_new_json;
end;
$$;

revoke all on function public.update_ad_targeting(uuid, uuid, text, text, text, text, text[], text, text, text, text) from public, anon, authenticated;
grant execute on function public.update_ad_targeting(uuid, uuid, text, text, text, text, text[], text, text, text, text) to service_role;
