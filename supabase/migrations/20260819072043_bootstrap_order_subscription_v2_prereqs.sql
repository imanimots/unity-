-- Bootstrap-order correction shim #2 (E50.2B).
--
-- 20260819072044_subscription_v2_plan_entitlements.sql and its sibling
-- Subscription V2 files (dated 2026-08-19, actually applied to
-- development much later -- see 20260819125238's own header) ALTER or
-- FK-reference six objects that, on a clean filename-order bootstrap,
-- do not exist yet: merchant_subscription_plans, merchant_subscriptions,
-- ad_advertisers, ad_packages, barter_skill_task_posts, ad_campaigns.
-- This migration creates ONLY the baseline shape each object's own
-- later authoritative migration originally established -- never the
-- evolved 271/273-migration final shape -- so each of those later
-- `create table if not exists` statements cleanly no-ops when it runs
-- at its normal position, and every later ALTER still applies exactly
-- as before. Column lists are copied verbatim from the authoritative
-- source migrations named in each section below.
--
-- Deliberately excluded (not needed to satisfy the forward DDL
-- dependency itself; left to run normally, unaffected, at each
-- object's original position):
--   - ad_advertiser_history, ad_campaign_history, ad_targeting,
--     ad_targeting_history (only referenced via INSERT INTO inside
--     deferred plpgsql function bodies in the Subscription V2 files --
--     harmless until actually called, long after all 273 migrations
--     have run; never a blocking DDL dependency)
--   - merchant_subscription_history, merchant_subscription_billing_attempts
--     (same: only INSERT INTO inside plpgsql bodies)
--   - every secondary index, trigger, RLS policy, grant, and seed-data
--     statement from the six objects' authoritative migrations --
--     CREATE INDEX/TRIGGER/POLICY IF NOT EXISTS-equivalents and
--     unconditional INSERT...ON CONFLICT statements are unaffected by
--     whether the table pre-existed, so they run normally and
--     completely at their original position
--
-- Transitive dependencies already satisfied by this point in the
-- chain: `profiles`, `listings`, `categories`, `subcategories` (all
-- from the initial schema / 2026-07-29), `marketplace_requests` (shim
-- #1, 20260819000012, which sorts before this file).

do $$
begin
  -- From 20260903000001_advertising_enums_and_advertisers.sql
  if not exists (select 1 from pg_type where typname = 'ad_advertiser_type') then
    create type ad_advertiser_type as enum ('unity', 'external');
  end if;
  if not exists (select 1 from pg_type where typname = 'ad_advertiser_status') then
    create type ad_advertiser_status as enum ('pending_review', 'active', 'approved', 'suspended', 'rejected');
  end if;
  -- From 20260903000002_advertising_packages.sql
  if not exists (select 1 from pg_type where typname = 'ad_inventory_class') then
    create type ad_inventory_class as enum ('unity_marketplace', 'external');
  end if;
  if not exists (select 1 from pg_type where typname = 'ad_placement_type') then
    create type ad_placement_type as enum ('homepage_banner', 'search_loading_popup', 'search_result', 'promoted_deals');
  end if;
  if not exists (select 1 from pg_type where typname = 'ad_placement_tier') then
    create type ad_placement_tier as enum ('value', 'standard', 'premium');
  end if;
  -- From 20260903000003_advertising_campaigns_and_targeting.sql
  if not exists (select 1 from pg_type where typname = 'ad_campaign_status') then
    create type ad_campaign_status as enum
      ('draft', 'funded', 'pending_review', 'active', 'paused', 'completed', 'cancelled', 'rejected', 'suspended');
  end if;
  if not exists (select 1 from pg_type where typname = 'ad_campaign_target_type') then
    create type ad_campaign_target_type as enum ('listing', 'marketplace_request', 'barter_skill_task_post', 'external');
  end if;
  -- From 20260901000001_skills_tasks_barter_enums.sql
  if not exists (select 1 from pg_type where typname = 'barter_skill_task_post_status') then
    create type barter_skill_task_post_status as enum (
      'draft', 'active', 'offers_received', 'matched', 'paused', 'closed', 'archived', 'suspended'
    );
  end if;
end$$;

-- ── merchant_subscription_plans ── baseline from 20260822000001 ──────
create table if not exists public.merchant_subscription_plans (
  id                       text primary key check (id in ('starter', 'pro', 'elite')),
  display_name             text not null,
  monthly_fee_cents        integer not null check (monthly_fee_cents >= 0),
  currency                 text not null default 'ZAR',
  sales_commission_bps     integer not null check (sales_commission_bps between 0 and 10000),
  rental_commission_bps    integer not null check (rental_commission_bps between 0 and 10000),
  barter_commission_bps    integer not null default 0 check (barter_commission_bps = 0),
  plan_rank                smallint not null unique check (plan_rank >= 0),
  active_listing_limit     integer check (active_listing_limit is null or active_listing_limit > 0),
  is_active                boolean not null default true,
  commercial_version       integer not null default 1,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

-- ── merchant_subscriptions ── baseline from 20260822000002 ───────────
create table if not exists public.merchant_subscriptions (
  id                          uuid primary key default gen_random_uuid(),
  merchant_id                 uuid not null unique references public.profiles(id),
  current_plan_id             text not null default 'starter' references public.merchant_subscription_plans(id),
  current_plan_effective_at   timestamptz not null default now(),
  pending_plan_id             text references public.merchant_subscription_plans(id),
  pending_plan_effective_at   timestamptz,
  status                      text not null default 'active'
                                check (status in ('active', 'pending_change', 'cancelled')),
  last_transition_category    text
                                check (last_transition_category is null or last_transition_category in
                                  ('upgrade', 'downgrade', 'cancellation', 'reversion', 'admin_correction', 'pending_change_cancelled')),
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  constraint merchant_subscriptions_pending_consistency check (
    (status = 'active' and pending_plan_id is null and pending_plan_effective_at is null)
    or (status in ('pending_change', 'cancelled') and pending_plan_id is not null and pending_plan_effective_at is not null)
  )
);

-- ── ad_advertisers ── baseline from 20260903000001 ────────────────────
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
  constraint ad_advertisers_status_matches_type check (
    (advertiser_type = 'unity' and status in ('active', 'suspended'))
    or (advertiser_type = 'external' and status in ('pending_review', 'approved', 'suspended', 'rejected'))
  )
);

-- ── ad_packages ── baseline from 20260903000002 ──────────────────────
create table if not exists public.ad_packages (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  inventory_class     ad_inventory_class not null,
  placement_type      ad_placement_type not null,
  placement_tier      ad_placement_tier not null,
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

-- ── barter_skill_task_posts ── baseline from 20260901000002 ──────────
create table if not exists public.barter_skill_task_posts (
  id                        uuid primary key default gen_random_uuid(),
  owner_id                  uuid not null references public.profiles(id),
  kind                      text not null check (kind in ('skill', 'task')),
  direction                 text not null check (direction in ('available', 'looking_for')),
  transaction_type          text not null default 'barter' check (transaction_type = 'barter'),
  status                    barter_skill_task_post_status not null default 'draft',
  pre_suspend_status        barter_skill_task_post_status,
  title                     text,
  description               text,
  category_id               uuid references public.categories(id),
  subcategory_id            uuid references public.subcategories(id),
  delivery_mode             text check (delivery_mode in ('remote', 'in_person', 'either')),
  province                  text,
  city                      text,
  exclusions                text,
  materials_arrangement     text,
  evidence_expectations     text,
  desired_exchange_notes    text,
  wants_item                boolean not null default false,
  wants_skill                boolean not null default false,
  wants_task                boolean not null default false,
  wants_cash_adjustment     boolean not null default false,
  availability_notes        text,
  preferred_start_date      date,
  preferred_start_time      time,
  deadline                  date,
  expected_duration_notes   text,
  reposted_from_post_id     uuid references public.barter_skill_task_posts(id),
  first_published_at        timestamptz,
  is_test                   boolean not null default false,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

-- ── ad_campaigns ── baseline from 20260903000003 ──────────────────────
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
