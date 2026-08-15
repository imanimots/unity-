-- Advertising MVP -- Phase 13: ad serving + impression/click recording.
--
-- The concurrency-critical core. `get_eligible_ads` is a read-only
-- selection query (rotation only, no mutation, so no lock is needed at
-- selection time). `record_ad_impression` is where the REAL quota
-- safety lives: it row-locks the campaign, re-checks quota remaining,
-- and increments atomically -- under concurrent public traffic a
-- campaign can never deliver more served impressions than its
-- purchased quota (binding, permanently regression-tested at the exact
-- boundary).
--
-- security definer throughout -- ad_campaigns/ad_targeting/ad_creatives
-- have no public SELECT policy (owner/admin read only), so a SECURITY
-- INVOKER function could never read across advertisers to select
-- rotation candidates. Every returned column is deliberately minimal
-- (target reference + creative fields needed to render a card) -- no
-- budget, no advertiser identity, no analytics ever leaves this
-- function, mirroring exactly how the Search Ranking RPCs return only
-- safe identifiers + ranking metadata, never full row data.

alter table public.ad_campaigns add column if not exists last_served_at timestamptz;

-- ── get_eligible_ads ──────────────────────────────────────────────────
-- p_rent_to_buy_enabled is passed in by the TypeScript caller (which
-- reads the real RENT_TO_BUY_ENABLED env var server-side) -- this
-- function never reads process.env itself, exactly like every other
-- RENT_TO_BUY_ENABLED gate in this codebase. An RTB-flavored listing
-- target (one with an enabled rent_to_buy_listing_terms row) is
-- excluded from serving unless the caller explicitly asserts the flag
-- is on.
create or replace function public.get_eligible_ads(
  p_placement_type ad_placement_type,
  p_mode text default null,
  p_direction text default null,
  p_kind text default null,
  p_category text default null,
  p_keywords text[] default '{}',
  p_country_id text default null,
  p_exclude_listing_ids uuid[] default '{}',
  p_exclude_marketplace_request_ids uuid[] default '{}',
  p_exclude_barter_skill_task_post_ids uuid[] default '{}',
  p_rent_to_buy_enabled boolean default false,
  p_limit int default 1
)
returns table (
  campaign_id uuid,
  target_type ad_campaign_target_type,
  listing_id uuid,
  marketplace_request_id uuid,
  barter_skill_task_post_id uuid,
  creative_headline text,
  creative_image_url text,
  creative_cta_text text
)
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  return query
  select
    c.id, c.target_type, c.listing_id, c.marketplace_request_id, c.barter_skill_task_post_id,
    cr.headline, cr.image_url, cr.cta_text
  from public.ad_campaigns c
  join public.ad_advertisers a on a.id = c.advertiser_id
  left join public.ad_targeting t on t.campaign_id = c.id
  left join public.ad_creatives cr on cr.campaign_id = c.id and c.target_type = 'external'
  where c.status = 'active'
    and c.snapshot_placement_type = p_placement_type
    and c.delivered_impressions < c.snapshot_impression_quota
    and (c.end_at is null or c.end_at > now())
    and c.is_test = false
    and a.status not in ('suspended', 'rejected')
    and (a.advertiser_type = 'unity' or a.status = 'approved')
    and (c.target_type <> 'external' or (cr.moderation_status = 'approved'))
    and (
      c.target_type <> 'listing'
      or not exists (select 1 from public.rent_to_buy_listing_terms rt where rt.listing_id = c.listing_id and rt.enabled = true)
      or p_rent_to_buy_enabled = true
    )
    and (p_mode is null or t.mode is null or t.mode = p_mode)
    and (p_direction is null or t.direction is null or t.direction = p_direction)
    and (p_kind is null or t.kind is null or t.kind = p_kind)
    and (p_category is null or t.category is null or t.category = p_category)
    and (p_country_id is null or t.country_id is null or t.country_id = p_country_id)
    and (t.keywords is null or array_length(t.keywords, 1) is null or p_keywords is null or array_length(p_keywords, 1) is null or t.keywords && p_keywords)
    and (c.listing_id is null or not (c.listing_id = any(p_exclude_listing_ids)))
    and (c.marketplace_request_id is null or not (c.marketplace_request_id = any(p_exclude_marketplace_request_ids)))
    and (c.barter_skill_task_post_id is null or not (c.barter_skill_task_post_id = any(p_exclude_barter_skill_task_post_ids)))
    and public._ad_target_is_live_eligible(c.id)
  order by
    (c.delivered_impressions::numeric / greatest(c.snapshot_impression_quota, 1)) asc,
    coalesce(c.last_served_at, c.activated_at, c.created_at) asc,
    c.activated_at asc nulls last,
    c.id asc
  limit greatest(p_limit, 0);
end;
$$;

revoke all on function public.get_eligible_ads(ad_placement_type, text, text, text, text, text[], text, uuid[], uuid[], uuid[], boolean, int) from public;
grant execute on function public.get_eligible_ads(ad_placement_type, text, text, text, text, text[], text, uuid[], uuid[], uuid[], boolean, int) to anon, authenticated;

-- ── record_ad_impression ── the quota-safety boundary ──────────────────
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

  -- Self-view exclusion (binding §59): an advertiser must never be able
  -- to burn their own campaign's quota by viewing/refreshing their own ad.
  if p_viewer_id is not null and p_viewer_id = v_advertiser.owner_profile_id then
    v_countable := false;
    v_exclusion := 'self_view';
  end if;

  insert into public.ad_impressions (campaign_id, placement_type, viewer_id, reach_key, countable, exclusion_reason)
  values (p_campaign_id, p_placement_type, p_viewer_id, p_reach_key, v_countable, v_exclusion)
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

revoke all on function public.record_ad_impression(uuid, ad_placement_type, uuid, text, text) from public;
grant execute on function public.record_ad_impression(uuid, ad_placement_type, uuid, text, text) to anon, authenticated;

-- ── record_ad_click ── analytics only, never billable, idempotent ──────
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

  -- Resolve the destination server-side -- the client never supplies an
  -- arbitrary redirect target (no open redirect).
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

revoke all on function public.record_ad_click(uuid, uuid, uuid, text, text) from public;
grant execute on function public.record_ad_click(uuid, uuid, uuid, text, text) to anon, authenticated;
