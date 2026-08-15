-- Advertising MVP -- Phase 3: campaigns + targeting.
--
-- Polymorphic Unity-marketplace target safety (binding): explicit
-- nullable FK columns + a CHECK requiring exactly one target family,
-- never an unchecked `target_type + target_id` pair. 'external'
-- campaigns have no Unity marketplace target at all (all three FKs
-- null) -- their target is a creative row (next migration).
--
-- No "exhausted" status exists -- this is a fixed prepaid-package
-- model, not CPC/CPM spend-down. Quota completion transitions directly
-- to 'completed', same as reaching the end date.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'ad_campaign_status') then
    create type ad_campaign_status as enum
      ('draft', 'funded', 'pending_review', 'active', 'paused', 'completed', 'cancelled', 'rejected', 'suspended');
  end if;
  if not exists (select 1 from pg_type where typname = 'ad_campaign_target_type') then
    create type ad_campaign_target_type as enum ('listing', 'marketplace_request', 'barter_skill_task_post', 'external');
  end if;
end$$;

create table if not exists public.ad_campaigns (
  id                         uuid primary key default gen_random_uuid(),
  advertiser_id              uuid not null references public.ad_advertisers(id),
  package_id                 uuid not null references public.ad_packages(id),
  status                     ad_campaign_status not null default 'draft',

  target_type                ad_campaign_target_type not null,
  listing_id                 uuid references public.listings(id),
  marketplace_request_id     uuid references public.marketplace_requests(id),
  barter_skill_task_post_id  uuid references public.barter_skill_task_posts(id),
  constraint ad_campaigns_target_matches_type check (
    (target_type = 'listing' and listing_id is not null and marketplace_request_id is null and barter_skill_task_post_id is null)
    or (target_type = 'marketplace_request' and marketplace_request_id is not null and listing_id is null and barter_skill_task_post_id is null)
    or (target_type = 'barter_skill_task_post' and barter_skill_task_post_id is not null and listing_id is null and marketplace_request_id is null)
    or (target_type = 'external' and listing_id is null and marketplace_request_id is null and barter_skill_task_post_id is null)
  ),

  -- Package-terms snapshot, captured once at funding time (fund_ad_campaign
  -- RPC, added in a later migration). A later admin edit to the ad_packages
  -- catalogue row must NEVER retroactively change these values.
  snapshot_placement_type    ad_placement_type not null,
  snapshot_placement_tier    ad_placement_tier not null,
  snapshot_position_band     text not null,
  snapshot_price_cents       integer not null,
  snapshot_currency          text not null,
  snapshot_impression_quota  integer not null,
  snapshot_commercial_version integer not null,

  delivered_impressions      integer not null default 0 check (delivered_impressions >= 0),
  funded_amount_cents        integer not null check (funded_amount_cents >= 0),

  end_at                     timestamptz,
  activated_at               timestamptz,
  completed_at               timestamptz,
  completion_reason          text check (completion_reason is null or completion_reason in
                                ('quota_reached', 'end_date_reached', 'admin_rejected', 'cancelled_pre_activation', 'cancelled_post_activation', 'admin_suspended', 'system_failure')),

  is_test                    boolean not null default false,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),

  constraint ad_campaigns_delivered_within_quota check (delivered_impressions <= snapshot_impression_quota),
  constraint ad_campaigns_end_after_activation check (end_at is null or activated_at is null or end_at > activated_at)
);

create index if not exists ad_campaigns_advertiser_idx on public.ad_campaigns(advertiser_id);
create index if not exists ad_campaigns_active_serving_idx on public.ad_campaigns(status, snapshot_placement_type, snapshot_placement_tier) where status = 'active';
create index if not exists ad_campaigns_listing_idx on public.ad_campaigns(listing_id) where listing_id is not null;
create index if not exists ad_campaigns_marketplace_request_idx on public.ad_campaigns(marketplace_request_id) where marketplace_request_id is not null;
create index if not exists ad_campaigns_barter_post_idx on public.ad_campaigns(barter_skill_task_post_id) where barter_skill_task_post_id is not null;

alter table public.ad_campaigns enable row level security;

create policy "ad_campaigns: owner read"
  on public.ad_campaigns for select
  using (exists (select 1 from public.ad_advertisers a where a.id = ad_campaigns.advertiser_id and a.owner_profile_id = auth.uid()));

create policy "ad_campaigns: admin read"
  on public.ad_campaigns for select
  using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));

-- Zero client write policies -- every transition goes through a
-- security definer RPC (added in a later migration).

-- ── ad_campaign_history ── immutable ──────────────────────────────────
create table if not exists public.ad_campaign_history (
  id               uuid primary key default gen_random_uuid(),
  campaign_id      uuid not null references public.ad_campaigns(id) on delete cascade,
  actor_type       text not null check (actor_type in ('system', 'advertiser', 'admin')),
  actor_id         uuid references public.profiles(id),
  action_type      text not null,
  previous_status  ad_campaign_status,
  new_status       ad_campaign_status,
  reason           text,
  created_at       timestamptz not null default now()
);

create index if not exists ad_campaign_history_campaign_idx on public.ad_campaign_history(campaign_id, created_at);

alter table public.ad_campaign_history enable row level security;

create policy "ad_campaign_history: owner read"
  on public.ad_campaign_history for select
  using (exists (
    select 1 from public.ad_campaigns c
    join public.ad_advertisers a on a.id = c.advertiser_id
    where c.id = ad_campaign_history.campaign_id and a.owner_profile_id = auth.uid()
  ));

create policy "ad_campaign_history: admin read"
  on public.ad_campaign_history for select
  using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));

drop trigger if exists ad_campaign_history_immutable on public.ad_campaign_history;
create trigger ad_campaign_history_immutable
  before update or delete on public.ad_campaign_history
  for each row execute procedure public.prevent_row_mutation();

-- ── ad_targeting ── current targeting state, one row per campaign ─────
-- Contextual only (binding): marketplace mode/direction/kind/category/
-- keywords/country, plus province/city ONLY when a genuine explicit
-- context exists to match against (see the ad-serving RPC migration's
-- own comment on why province/city are schema-ready but not populated
-- from any inferred/behavioral source). No behavioral/demographic/
-- device columns exist here by design.
create table if not exists public.ad_targeting (
  campaign_id   uuid primary key references public.ad_campaigns(id) on delete cascade,
  mode          text,
  direction     text,
  kind          text,
  category      text,
  keywords      text[] not null default '{}',
  country_id    text,
  province      text,
  city          text,
  updated_at    timestamptz not null default now(),
  constraint ad_targeting_keywords_bounded check (array_length(keywords, 1) is null or array_length(keywords, 1) <= 20)
);

alter table public.ad_targeting enable row level security;

create policy "ad_targeting: owner read"
  on public.ad_targeting for select
  using (exists (
    select 1 from public.ad_campaigns c
    join public.ad_advertisers a on a.id = c.advertiser_id
    where c.id = ad_targeting.campaign_id and a.owner_profile_id = auth.uid()
  ));

create policy "ad_targeting: admin read"
  on public.ad_targeting for select
  using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));

-- ── ad_targeting_history ── immutable, one row per change ─────────────
create table if not exists public.ad_targeting_history (
  id                 uuid primary key default gen_random_uuid(),
  campaign_id        uuid not null references public.ad_campaigns(id) on delete cascade,
  previous_targeting jsonb,
  new_targeting      jsonb not null,
  actor_type         text not null check (actor_type in ('system', 'advertiser', 'admin')),
  actor_id           uuid references public.profiles(id),
  created_at         timestamptz not null default now()
);

create index if not exists ad_targeting_history_campaign_idx on public.ad_targeting_history(campaign_id, created_at);

alter table public.ad_targeting_history enable row level security;

create policy "ad_targeting_history: owner read"
  on public.ad_targeting_history for select
  using (exists (
    select 1 from public.ad_campaigns c
    join public.ad_advertisers a on a.id = c.advertiser_id
    where c.id = ad_targeting_history.campaign_id and a.owner_profile_id = auth.uid()
  ));

create policy "ad_targeting_history: admin read"
  on public.ad_targeting_history for select
  using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));

drop trigger if exists ad_targeting_history_immutable on public.ad_targeting_history;
create trigger ad_targeting_history_immutable
  before update or delete on public.ad_targeting_history
  for each row execute procedure public.prevent_row_mutation();
