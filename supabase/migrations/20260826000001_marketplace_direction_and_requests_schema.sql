-- ============================================================
-- Phase 4 -- Available / Looking For marketplace: core schema.
-- ============================================================
-- marketplace_direction: one explicit, queryable concept -- 'available'
-- (existing supply-side listings) vs 'looking_for' (demand-side
-- requests, a separate table -- see decision below). Never inferred
-- from missing fields.
--
-- listings.direction: added NOT NULL DEFAULT 'available' -- Postgres
-- backfills every existing row atomically as part of the ALTER (no
-- separate UPDATE needed, no table rewrite risk on the version this
-- project targets). Every existing listing becomes 'available' by
-- construction, with no other column touched (test classification,
-- approval status, publication status, seller, transaction type,
-- pricing, and history are all left exactly as they are).
--
-- Looking For is NOT forced into `listings` -- a demand-side request
-- has no price, no photos, no ownership proof, no availability
-- calendar, and would add a large block of always-null supply-side
-- columns to every request row (per this migration's own header
-- reasoning in the Phase 4 brief). A dedicated table is cleaner:
--
-- marketplace_requests: one row per demand-side post. transaction_type
-- mirrors the exact 3 canonical values already exposed elsewhere
-- (buy/rent/barter) via a plain text CHECK, not a new enum coupled to
-- listing_type -- listing_type has no 'barter' value (any active,
-- unlocked listing is barter-eligible regardless of listing_type), and
-- rent_to_buy must be addable later as a 4th CHECK value without an
-- enum migration (Step AM extensibility test).
--
-- marketplace_request_offers: first-class response/offer record, one
-- row per response (link_listing / private_offer / message_only /
-- public_listing). Snapshots the economically important accepted terms
-- so accepting later never silently uses since-changed mutable
-- listing/request data.
--
-- marketplace_request_history: append-only audit trail for both
-- requests and offers (offer_id nullable so both share one table,
-- mirroring dispute_history's single-table-covers-related-entities
-- precedent), reusing prevent_row_mutation() -- never redefined.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

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

-- ── listings.direction ──────────────────────────────────────
alter table public.listings add column if not exists direction marketplace_direction not null default 'available';
create index if not exists listings_direction_idx on public.listings(direction);

-- ── marketplace_requests ─────────────────────────────────────
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

create index if not exists marketplace_requests_requester_idx on public.marketplace_requests(requester_id);
create index if not exists marketplace_requests_status_idx on public.marketplace_requests(status);
create index if not exists marketplace_requests_type_idx on public.marketplace_requests(transaction_type);
create index if not exists marketplace_requests_country_idx on public.marketplace_requests(country_id);
create index if not exists marketplace_requests_category_idx on public.marketplace_requests(category_id);
create index if not exists marketplace_requests_expires_idx on public.marketplace_requests(expires_at) where status in ('active', 'offers_received');

create or replace function public.touch_marketplace_request_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists marketplace_requests_touch_updated_at on public.marketplace_requests;
create trigger marketplace_requests_touch_updated_at
  before update on public.marketplace_requests
  for each row execute procedure public.touch_marketplace_request_updated_at();

-- ── marketplace_request_offers ───────────────────────────────
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

create index if not exists marketplace_request_offers_request_idx on public.marketplace_request_offers(request_id);
create index if not exists marketplace_request_offers_responder_idx on public.marketplace_request_offers(responder_id);
create index if not exists marketplace_request_offers_status_idx on public.marketplace_request_offers(status);
-- At most one PENDING offer per (request, responder) for economically
-- committal offer types -- a responder may still message_only more than
-- once, but cannot stack multiple simultaneous commercial offers on the
-- same request.
create unique index if not exists marketplace_request_offers_one_pending_commercial_uq
  on public.marketplace_request_offers(request_id, responder_id)
  where status = 'pending' and offer_type <> 'message_only';

drop trigger if exists marketplace_request_offers_touch_updated_at on public.marketplace_request_offers;
create trigger marketplace_request_offers_touch_updated_at
  before update on public.marketplace_request_offers
  for each row execute procedure public.touch_marketplace_request_updated_at();

-- ── marketplace_request_history (append-only) ────────────────
create table if not exists public.marketplace_request_history (
  id               uuid primary key default extensions.uuid_generate_v4(),
  request_id       uuid not null references public.marketplace_requests(id),
  offer_id         uuid references public.marketplace_request_offers(id),
  actor_role       text not null check (actor_role in ('requester', 'responder', 'system', 'admin')),
  actor_id         uuid references public.profiles(id),
  event_type       text not null,
  previous_status  text,
  new_status       text,
  metadata         jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now()
);

create index if not exists marketplace_request_history_request_idx on public.marketplace_request_history(request_id, created_at);

drop trigger if exists marketplace_request_history_immutable on public.marketplace_request_history;
create trigger marketplace_request_history_immutable
  before update or delete on public.marketplace_request_history
  for each row execute function public.prevent_row_mutation();

-- ── RLS ───────────────────────────────────────────────────────
alter table public.marketplace_requests enable row level security;
alter table public.marketplace_request_offers enable row level security;
alter table public.marketplace_request_history enable row level security;

-- Public can read ACTIVE/offers_received/matched/completed requests
-- that are not test fixtures (mirrors excludeTestListings()'s own
-- public/production-style query boundary) -- draft requests are
-- private to their owner. Closed/archived/date_passed stay visible so
-- an existing conversation/offer thread referencing them doesn't 404.
create policy "marketplace_requests: public read (published, non-test)"
  on public.marketplace_requests for select
  using (status <> 'draft' and is_test = false);

create policy "marketplace_requests: owner read own (including draft/test)"
  on public.marketplace_requests for select
  using (requester_id = auth.uid());

-- Zero client write policies -- every mutation goes through a
-- SECURITY DEFINER, service-role-only RPC, matching barter_agreements/
-- disputes/affiliate_commissions/escrow_transactions' fully RPC-gated
-- model exactly.

create policy "marketplace_request_offers: requester reads offers on own request"
  on public.marketplace_request_offers for select
  using (exists (select 1 from public.marketplace_requests r where r.id = marketplace_request_offers.request_id and r.requester_id = auth.uid()));

create policy "marketplace_request_offers: responder reads own offers"
  on public.marketplace_request_offers for select
  using (responder_id = auth.uid());

-- Public-linked offers (public_listing / link_listing) that have been
-- ACCEPTED expose only that they exist and won -- via the request's own
-- matched_offer_id, not via a broad offers-read policy. No additional
-- policy needed here: a non-participant simply has no read access to
-- individual offer rows at all, matching Step AH exactly ("other users
-- cannot read private custom offers").

create policy "marketplace_request_history: requester reads own request history"
  on public.marketplace_request_history for select
  using (exists (select 1 from public.marketplace_requests r where r.id = marketplace_request_history.request_id and r.requester_id = auth.uid()));

create policy "marketplace_request_history: responder reads history for own offers"
  on public.marketplace_request_history for select
  using (offer_id is not null and exists (select 1 from public.marketplace_request_offers o where o.id = marketplace_request_history.offer_id and o.responder_id = auth.uid()));
