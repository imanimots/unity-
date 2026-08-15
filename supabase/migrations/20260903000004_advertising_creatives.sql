-- Advertising MVP -- Phase 4: external creative.
--
-- Unity-marketplace campaigns (target_type IN ('listing',
-- 'marketplace_request', 'barter_skill_task_post')) have NO row here --
-- their creative is the existing marketplace card, rendered from the
-- target's own already-moderated data (binding: "MVP creative = EXISTING
-- MARKETPLACE CARD DATA. No custom merchant headline/image/copy").
-- External campaigns (target_type = 'external') have exactly one
-- creative row, which must be manually admin-approved before the
-- campaign may ever serve, and any material change after approval
-- invalidates that approval and forces re-review (enforced in the RPC
-- layer, since this table has zero client write policies regardless).

do $$
begin
  if not exists (select 1 from pg_type where typname = 'ad_creative_moderation_status') then
    create type ad_creative_moderation_status as enum ('pending_review', 'approved', 'rejected');
  end if;
end$$;

create table if not exists public.ad_creatives (
  id                 uuid primary key default gen_random_uuid(),
  campaign_id        uuid not null unique references public.ad_campaigns(id) on delete cascade,
  headline           text not null check (char_length(headline) between 1 and 120),
  image_url          text,
  cta_text           text not null check (char_length(cta_text) between 1 and 40),
  destination_url    text not null check (destination_url ~ '^https://'),
  short_description  text check (short_description is null or char_length(short_description) <= 300),
  moderation_status  ad_creative_moderation_status not null default 'pending_review',
  approved_by        uuid references public.profiles(id),
  approved_at        timestamptz,
  approved_version   integer not null default 0,
  rejection_reason   text,
  is_test            boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists ad_creatives_campaign_idx on public.ad_creatives(campaign_id);

alter table public.ad_creatives enable row level security;

create policy "ad_creatives: owner read"
  on public.ad_creatives for select
  using (exists (
    select 1 from public.ad_campaigns c
    join public.ad_advertisers a on a.id = c.advertiser_id
    where c.id = ad_creatives.campaign_id and a.owner_profile_id = auth.uid()
  ));

create policy "ad_creatives: admin read"
  on public.ad_creatives for select
  using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));

-- Zero client write policies -- create/update/approve/reject all go
-- through security definer RPCs (added in a later migration), which are
-- the only place "material change invalidates approval" is enforced.

-- ── ad_creative_history ── immutable audit of moderation decisions ────
create table if not exists public.ad_creative_history (
  id               uuid primary key default gen_random_uuid(),
  creative_id      uuid not null references public.ad_creatives(id) on delete cascade,
  actor_type       text not null check (actor_type in ('system', 'advertiser', 'admin')),
  actor_id         uuid references public.profiles(id),
  action_type      text not null,
  previous_status  ad_creative_moderation_status,
  new_status       ad_creative_moderation_status,
  reason           text,
  created_at       timestamptz not null default now()
);

create index if not exists ad_creative_history_creative_idx on public.ad_creative_history(creative_id, created_at);

alter table public.ad_creative_history enable row level security;

create policy "ad_creative_history: owner read"
  on public.ad_creative_history for select
  using (exists (
    select 1 from public.ad_creatives cr
    join public.ad_campaigns c on c.id = cr.campaign_id
    join public.ad_advertisers a on a.id = c.advertiser_id
    where cr.id = ad_creative_history.creative_id and a.owner_profile_id = auth.uid()
  ));

create policy "ad_creative_history: admin read"
  on public.ad_creative_history for select
  using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));

drop trigger if exists ad_creative_history_immutable on public.ad_creative_history;
create trigger ad_creative_history_immutable
  before update or delete on public.ad_creative_history
  for each row execute procedure public.prevent_row_mutation();
