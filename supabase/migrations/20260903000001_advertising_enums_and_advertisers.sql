-- Advertising MVP -- Phase 1: shared enums + advertiser-account domain.
--
-- Two advertiser classes (binding, per the Advertising MVP authoritative
-- prompt): 'unity' (a registered Unity user/merchant advertising their own
-- eligible marketplace content -- auto-approved, no manual gate) and
-- 'external' (a company/brand advertising through Unity with no
-- marketplace inventory -- requires explicit admin approval before any
-- campaign of theirs may serve). This table is deliberately NOT a new KYC
-- provider -- it reuses the existing `profiles`/KYC identity a Unity user
-- already has, plus a manual admin-approval gate for the external case,
-- exactly matching the prompt's "reuse existing identity/account
-- conventions where appropriate, plus explicit manual advertiser
-- approval" instruction.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'ad_advertiser_type') then
    create type ad_advertiser_type as enum ('unity', 'external');
  end if;
  if not exists (select 1 from pg_type where typname = 'ad_advertiser_status') then
    -- 'active' is the only status a 'unity' advertiser account ever has
    -- (no manual gate). 'external' advertisers move
    -- pending_review -> approved -> (suspended|rejected).
    create type ad_advertiser_status as enum ('pending_review', 'active', 'approved', 'suspended', 'rejected');
  end if;
end$$;

-- ── ad_advertisers ──────────────────────────────────────────────────
-- One row per advertiser account. `owner_profile_id` is the accountable
-- registered Unity user for BOTH advertiser types -- for 'unity'
-- advertisers this is simply the merchant themselves; for 'external'
-- advertisers this is the registered Unity user who administers that
-- company's campaigns (no unauthenticated external company can ever
-- administer a campaign directly, per the binding prompt).
create table if not exists public.ad_advertisers (
  id                 uuid primary key default gen_random_uuid(),
  owner_profile_id   uuid not null references public.profiles(id),
  advertiser_type    ad_advertiser_type not null,
  display_name       text not null,
  status             ad_advertiser_status not null default 'active',
  approved_by        uuid references public.profiles(id),
  approved_at        timestamptz,
  suspension_reason  text,
  is_test            boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  -- A 'unity' advertiser account is always 'active' immediately (no
  -- review gate); an 'external' one always starts 'pending_review'.
  constraint ad_advertisers_status_matches_type check (
    (advertiser_type = 'unity' and status in ('active', 'suspended'))
    or (advertiser_type = 'external' and status in ('pending_review', 'approved', 'suspended', 'rejected'))
  )
);

create index if not exists ad_advertisers_owner_idx on public.ad_advertisers(owner_profile_id);

alter table public.ad_advertisers enable row level security;

create policy "ad_advertisers: owner read"
  on public.ad_advertisers for select
  using (owner_profile_id = auth.uid());

create policy "ad_advertisers: admin read"
  on public.ad_advertisers for select
  using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));

-- Zero client write policies -- every state change goes through a
-- security definer RPC (created in a later Advertising migration),
-- matching every other financial/authority table in this codebase.

-- ── ad_advertiser_history ── immutable audit trail ──────────────────
create table if not exists public.ad_advertiser_history (
  id               uuid primary key default gen_random_uuid(),
  advertiser_id    uuid not null references public.ad_advertisers(id) on delete cascade,
  actor_type       text not null check (actor_type in ('system', 'advertiser', 'admin')),
  actor_id         uuid references public.profiles(id),
  action_type      text not null,
  previous_status  ad_advertiser_status,
  new_status       ad_advertiser_status,
  reason           text,
  created_at       timestamptz not null default now()
);

create index if not exists ad_advertiser_history_advertiser_idx on public.ad_advertiser_history(advertiser_id, created_at);

alter table public.ad_advertiser_history enable row level security;

create policy "ad_advertiser_history: owner read"
  on public.ad_advertiser_history for select
  using (exists (select 1 from public.ad_advertisers a where a.id = ad_advertiser_history.advertiser_id and a.owner_profile_id = auth.uid()));

create policy "ad_advertiser_history: admin read"
  on public.ad_advertiser_history for select
  using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));

-- Immutable -- reuses the existing prevent_row_mutation() trigger
-- function (defined in 20260729000003_listing_declarations_and_history.sql),
-- never redefined.
drop trigger if exists ad_advertiser_history_immutable on public.ad_advertiser_history;
create trigger ad_advertiser_history_immutable
  before update or delete on public.ad_advertiser_history
  for each row execute procedure public.prevent_row_mutation();
