-- Advertising MVP -- Phase 2: package catalogue.
--
-- Fixed prepaid packages, NOT CPC/CPM/auction (binding). A package
-- purchases a placement type + prominence tier + a bounded impression
-- allocation for a fixed price. No production Rand amounts are seeded by
-- this migration or any application code -- the catalogue starts EMPTY;
-- an admin must deliberately configure real package rows before any real
-- advertiser can purchase one. Regression/QA scripts create their own
-- is_test=true rows.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'ad_inventory_class') then
    create type ad_inventory_class as enum ('unity_marketplace', 'external');
  end if;
  if not exists (select 1 from pg_type where typname = 'ad_placement_type') then
    create type ad_placement_type as enum ('homepage_banner', 'search_loading_popup', 'search_result', 'promoted_deals');
  end if;
  if not exists (select 1 from pg_type where typname = 'ad_placement_tier') then
    -- Ordered low -> high prominence; used for deterministic comparisons
    -- (e.g. "does this campaign's tier outrank that one") without a
    -- separate numeric column -- Postgres enums compare by declaration
    -- order.
    create type ad_placement_tier as enum ('value', 'standard', 'premium');
  end if;
end$$;

-- ── ad_packages ── admin-configurable catalogue, no hardcoded prices ──
create table if not exists public.ad_packages (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  inventory_class     ad_inventory_class not null,
  placement_type      ad_placement_type not null,
  placement_tier      ad_placement_tier not null,
  -- Logical slot/position band, not a CSS row number -- e.g. 'earliest',
  -- 'middle', 'lower'. Free text so admins can adjust band semantics
  -- without a schema migration, per the binding prompt ("should allow
  -- these placement bands to change without a schema migration").
  position_band       text not null,
  price_cents         integer not null check (price_cents >= 0),
  currency            text not null default 'ZAR',
  impression_quota    integer not null check (impression_quota > 0),
  is_active           boolean not null default false,
  commercial_version  integer not null default 1,
  is_test             boolean not null default false,
  created_by          uuid references public.profiles(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists ad_packages_active_idx on public.ad_packages(inventory_class, placement_type, placement_tier) where is_active = true;

alter table public.ad_packages enable row level security;

create policy "ad_packages: admin read"
  on public.ad_packages for select
  using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));

-- No broad public/authenticated SELECT policy on the base table -- an
-- explicit-column public view is created below instead, matching the
-- public_profiles / barter_skill_task_public_posts pattern exactly.
-- Zero client write policies -- catalogue changes go through admin RPCs.

-- ── ad_packages_public ── the only surface an advertiser ever reads
-- when choosing a package. Excludes internal columns (created_by,
-- commercial_version's edit history is not exposed, is_test is
-- exposed only implicitly by never appearing since the view filters
-- it out) and is filtered to genuinely purchasable rows only. ──
create or replace view public.ad_packages_public as
select id, name, inventory_class, placement_type, placement_tier, position_band,
       price_cents, currency, impression_quota, commercial_version, created_at
from public.ad_packages
where is_active = true and is_test = false;

grant select on public.ad_packages_public to anon, authenticated;
