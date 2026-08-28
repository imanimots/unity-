-- Advertising MVP -- serving authority hardening (Blocker 1 closure).
--
-- PROVEN GAP: get_eligible_ads() (20260903000013) never referenced
-- ad_campaign_funding/ad_provider_settlements at all -- eligibility was
-- based purely on ad_campaigns.status = 'active' plus targeting/quota/
-- expiry/moderation checks. A campaign that reached 'active' via the
-- pre-hardening mock-trust path (funding_source='provider',
-- ad_campaign_funding.settlement_id NULL, from before migration
-- 20260904000016) would have been structurally indistinguishable from a
-- genuinely settlement-backed campaign at serve time.
--
-- Historical-data audit (read-only, no data touched by this migration):
-- 185 legacy provider-funded rows with settlement_id NULL exist; 0 of
-- the 160 is_test=false ones are currently status='active' (all have
-- since reached completed/cancelled/suspended over the life of this dev
-- database) -- but that is incidental current state, not a structural
-- guarantee, and the brief explicitly requires an authority-level fix
-- regardless of today's counts. No settlement is fabricated or
-- backfilled for any historical row by this migration; they remain
-- permanently unable to serve by construction, exactly like a campaign
-- that was never funded at all.
--
-- Fix: get_eligible_ads gains exactly one new condition -- a campaign's
-- OWN ad_campaign_funding row must show either a 'balance' funding
-- source (always trusted, completely unaffected by this migration) or a
-- 'provider' funding source WITH a non-null settlement_id (the
-- verified-settlement authority introduced by 20260904000016). True
-- superset of the current live body (this is the only migration that
-- has ever defined this function, confirmed by an exhaustive grep of
-- every 2026090*.sql migration for "get_eligible_ads" before writing
-- this one) -- every other condition is byte-identical, unchanged.
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
    -- Settlement authority (new): a campaign may only serve if its own
    -- funding row shows genuine authority to have been activated --
    -- balance funding is always trusted; provider funding requires a
    -- linked verified settlement. A campaign with no funding row at all
    -- (should be structurally impossible for status='active', but
    -- checked explicitly rather than assumed) also fails this and never
    -- serves.
    and exists (
      select 1 from public.ad_campaign_funding f
      where f.campaign_id = c.id
        and (f.funding_source = 'balance' or f.settlement_id is not null)
    )
  order by
    (c.delivered_impressions::numeric / greatest(c.snapshot_impression_quota, 1)) asc,
    coalesce(c.last_served_at, c.activated_at, c.created_at) asc,
    c.activated_at asc nulls last,
    c.id asc
  limit greatest(p_limit, 0);
end;
$$;
