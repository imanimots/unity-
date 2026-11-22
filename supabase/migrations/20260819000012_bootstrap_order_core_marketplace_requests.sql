-- Bootstrap-order correction shim (E50.2, Gate 1 probe + genuine fix).
--
-- marketplace_requests and marketplace_request_offers are not created
-- until 20260826000001_marketplace_direction_and_requests_schema.sql,
-- but two later "V2" migration clusters -- dated 2026-08-19
-- (Subscription V2) and 2026-08-21 (RTB V2) -- were authored with
-- filenames timestamped BEFORE they were actually written and applied
-- to development (see 20260819125238_subscription_v2_out_of_order_fix_
-- forward.sql's own header: the real mechanism was `supabase db push
-- --linked --include-all`, applied well after 2026-08-22 onward had
-- already run). Those two clusters transitively reference these two
-- tables (ad_campaigns.marketplace_request_id,
-- rent_to_buy_agreements.request_id/offer_id) before they would
-- otherwise exist on a clean, from-scratch bootstrap -- confirmed as
-- the production deployment failure's root cause this phase (E50.2).
--
-- This migration creates ONLY the baseline shape 20260826000001 itself
-- originally established -- not the eventual final shape after later
-- ALTER migrations added more columns -- so that 20260826000001's own
-- `create table if not exists` cleanly no-ops when it runs at its
-- normal position, and every later ALTER against these two tables
-- still applies normally regardless of which migration actually
-- created the table first. Column lists below are copied verbatim from
-- 20260826000001's own CREATE TABLE statements.
--
-- Deliberately excluded (not needed to satisfy the forward FK/column
-- dependency itself; left to run normally at their original position
-- in 20260826000001):
--   - marketplace_request_history (no blocking migration references it)
--   - listings.direction (no blocking migration references it)
--   - every secondary index beyond the primary keys the FK references
--     already require (CREATE INDEX IF NOT EXISTS is unaffected by
--     whether the table pre-existed)
--   - triggers, RLS, policies (irrelevant to whether a later ALTER
--     TABLE / FK reference can resolve the table's existence)
--
-- This is also, deliberately, the empirical test for E50.2 Gate 1: its
-- version (20260819000012) is older than staging's current migration
-- head, so whether the Supabase GitHub "Deploy to production"
-- integration applies an out-of-order migration at all is itself the
-- open question this migration's own deploy result answers.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'marketplace_direction') then
    create type marketplace_direction as enum ('available', 'looking_for');
  end if;
  if not exists (select 1 from pg_type where typname = 'marketplace_request_status') then
    create type marketplace_request_status as enum ('draft', 'active', 'offers_received', 'matched', 'closed', 'date_passed', 'completed', 'archived');
  end if;
  if not exists (select 1 from pg_type where typname = 'marketplace_offer_status') then
    create type marketplace_offer_status as enum ('pending', 'accepted', 'declined', 'withdrawn', 'expired');
  end if;
end$$;

create table if not exists public.marketplace_requests (
  id                       uuid primary key default extensions.uuid_generate_v4(),
  requester_id             uuid not null references public.profiles(id),
  transaction_type         text not null check (transaction_type in ('buy', 'rent', 'barter')),
  status                   marketplace_request_status not null default 'draft',

  title                    text not null,
  description              text,
  category                 text,
  category_id              uuid references public.categories(id),
  subcategory_id           uuid references public.subcategories(id),
  country_id               text not null default 'ZA' references public.countries(id),
  province                 text,
  city                     text,

  budget_min               numeric(10,2),
  budget_max               numeric(10,2),
  currency                 text not null default 'ZAR',

  -- Rental-only date requirement (Step K). NULL for buy/barter.
  start_date               date,
  end_date                 date,

  quantity                 int not null default 1,
  condition_preferences    text,
  barter_offer_description text,
  specifications           jsonb not null default '{}'::jsonb,

  expires_at               timestamptz,
  matched_at               timestamptz,
  matched_offer_id         uuid,
  reposted_from_request_id uuid references public.marketplace_requests(id),

  is_test                  boolean not null default false,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  constraint marketplace_requests_rental_dates_chk check (
    transaction_type <> 'rent' or (start_date is not null and end_date is not null and end_date > start_date)
  ),
  constraint marketplace_requests_budget_chk check (
    budget_min is null or budget_max is null or budget_max >= budget_min
  )
);

create table if not exists public.marketplace_request_offers (
  id                  uuid primary key default extensions.uuid_generate_v4(),
  request_id          uuid not null references public.marketplace_requests(id),
  responder_id        uuid not null references public.profiles(id),
  offer_type          text not null check (offer_type in ('link_listing', 'private_offer', 'message_only', 'public_listing')),
  status              marketplace_offer_status not null default 'pending',

  linked_listing_id   uuid references public.listings(id),

  amount              numeric(10,2),
  currency            text not null default 'ZAR',
  rental_start_date   date,
  rental_end_date     date,
  cash_adjustment     numeric(10,2),
  message             text,

  -- Snapshot of the economically important terms at ACCEPT time --
  -- written once by accept_marketplace_offer(), never by a client.
  terms_snapshot      jsonb,

  is_test             boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  accepted_at         timestamptz,
  declined_at         timestamptz,
  withdrawn_at        timestamptz,

  constraint marketplace_request_offers_listing_types_chk check (
    offer_type not in ('link_listing', 'public_listing') or linked_listing_id is not null
  )
);
