-- ============================================================
-- Booking schema (Phase 2B)
-- ============================================================
-- Extends the existing bookings table (20260613000001_initial_schema)
-- rather than replacing it. bookings has 0 live rows as of this
-- migration (verified live before writing this).
--
-- Five pre-existing NOT NULL columns (start_date, end_date, total_days,
-- rental_fee, total_amount) are superseded by the richer snapshot columns
-- added below (start_at/end_at as timestamptz, subtotal_amount, etc.) and
-- are relaxed to nullable rather than dropped -- nothing in this schema
-- reads them, dropping them is not required, and relaxing preserves the
-- column for any future consumer without fabricating redundant data into
-- it. deposit_amount and shipping_fee already have defaults and are left
-- as-is; deposit_amount_snapshot below is the Phase 2B source of truth.
--
-- Booking creation and every lifecycle transition happens exclusively
-- through the RPCs in 20260730000007_booking_rpcs.sql, which are
-- restricted to the service role (see 20260730000006_booking_security.sql)
-- -- the same pattern already proven for submit_listing_for_review in
-- 20260730000002_restrict_submit_to_server.sql. This migration is schema
-- only.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

alter table public.bookings
  alter column start_date drop not null,
  alter column end_date drop not null,
  alter column total_days drop not null,
  alter column rental_fee drop not null,
  alter column total_amount drop not null;

comment on column public.bookings.start_date is 'Superseded by start_at (timestamptz). Unused by Phase 2B, left nullable for compatibility.';
comment on column public.bookings.end_date is 'Superseded by end_at (timestamptz). Unused by Phase 2B, left nullable for compatibility.';
comment on column public.bookings.total_days is 'Superseded by duration_units. Unused by Phase 2B, left nullable for compatibility.';
comment on column public.bookings.rental_fee is 'Superseded by subtotal_amount. Unused by Phase 2B, left nullable for compatibility.';
comment on column public.bookings.total_amount is 'Superseded by renter_total_amount. Unused by Phase 2B, left nullable for compatibility.';

create or replace function public.generate_booking_reference()
returns text
language sql
as $$
  select 'UN-' || upper(substr(md5(gen_random_uuid()::text), 1, 8));
$$;

alter table public.bookings
  add column if not exists booking_reference text,
  add column if not exists version int not null default 1,

  -- Canonical UTC interval. Semantics: [start_at, end_at) -- start
  -- inclusive, end exclusive. See docs/BOOKING_LIFECYCLE.md.
  add column if not exists start_at timestamptz,
  add column if not exists end_at timestamptz,

  add column if not exists requested_at timestamptz not null default now(),
  add column if not exists accepted_at timestamptz,
  add column if not exists rejected_at timestamptz,
  add column if not exists expires_at timestamptz,
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancelled_by uuid references public.profiles(id),
  add column if not exists rental_started_at timestamptz,
  add column if not exists return_initiated_at timestamptz,
  add column if not exists returned_at timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists updated_at timestamptz not null default now(),

  add column if not exists renter_message text,
  add column if not exists merchant_response_note text,
  add column if not exists cancellation_reason text,
  add column if not exists rejection_reason text,

  -- Financial snapshot -- computed once at request time, never re-derived
  -- from the listing's current state. All amounts are numeric(12,2),
  -- never floating point.
  add column if not exists currency text not null default 'ZAR',
  add column if not exists rate_amount numeric(12,2),
  add column if not exists rate_unit text,
  add column if not exists duration_units numeric(10,2),
  add column if not exists subtotal_amount numeric(12,2),
  add column if not exists deposit_amount_snapshot numeric(12,2) not null default 0,
  add column if not exists platform_fee_amount numeric(12,2) not null default 0,
  add column if not exists renter_total_amount numeric(12,2),
  add column if not exists merchant_proceeds_estimate numeric(12,2),
  add column if not exists price_calculation_version text not null default 'v1',

  -- Terms snapshot -- listing_requirements + relevant listings fields as
  -- they existed at request time. A later listing edit never changes an
  -- existing booking's snapshot. See docs/BOOKING_LIFECYCLE.md for the
  -- exact shape.
  add column if not exists terms_snapshot jsonb not null default '{}'::jsonb,
  add column if not exists terms_snapshot_version text not null default 'v1';

alter table public.bookings
  add constraint bookings_reference_unique unique (booking_reference);

alter table public.bookings
  add constraint bookings_renter_not_merchant_chk check (renter_id <> merchant_id);

alter table public.bookings
  add constraint bookings_interval_chk check (start_at is null or end_at is null or start_at < end_at);

alter table public.bookings
  add constraint bookings_duration_positive_chk check (duration_units is null or duration_units > 0);

alter table public.bookings
  add constraint bookings_rate_unit_chk check (rate_unit is null or rate_unit in ('hourly', 'daily', 'weekend', 'weekly', 'monthly', 'fixed'));

alter table public.bookings
  add constraint bookings_amounts_non_negative_chk check (
    (subtotal_amount is null or subtotal_amount >= 0)
    and deposit_amount_snapshot >= 0
    and platform_fee_amount >= 0
    and (renter_total_amount is null or renter_total_amount >= 0)
    and (merchant_proceeds_estimate is null or merchant_proceeds_estimate >= 0)
  );

-- ------------------------------------------------------------
-- Race-safe conflict prevention: only 'accepted' and 'active' bookings
-- block a listing's dates. 'requested' bookings do not reserve dates --
-- multiple renters may request overlapping dates; accepting one is what
-- makes conflicting requests unacceptable (handled in the accept RPC,
-- see 20260730000007). This is enforced at the database level via an
-- exclusion constraint, not just checked in application code, so two
-- concurrent accept attempts on overlapping dates cannot both succeed --
-- Postgres itself refuses the second commit. See docs/BOOKING_LIFECYCLE.md
-- "Availability and conflict model" for the full rationale.
-- ------------------------------------------------------------
create extension if not exists btree_gist;

alter table public.bookings
  add constraint bookings_no_overlap_when_blocking
  exclude using gist (
    listing_id with =,
    tstzrange(start_at, end_at, '[)') with &&
  ) where (status in ('accepted', 'active'));

create index if not exists bookings_reference_idx on public.bookings(booking_reference);
create index if not exists bookings_status_listing_idx on public.bookings(listing_id, status);
create index if not exists bookings_renter_status_idx on public.bookings(renter_id, status);
create index if not exists bookings_merchant_status_idx on public.bookings(merchant_id, status);
create index if not exists bookings_start_at_idx on public.bookings(start_at);
create index if not exists bookings_expires_at_idx on public.bookings(expires_at) where status = 'requested';
create index if not exists bookings_created_at_idx on public.bookings(created_at);

create or replace function public.touch_booking_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists bookings_touch_updated_at on public.bookings;
create trigger bookings_touch_updated_at
  before update on public.bookings
  for each row execute procedure public.touch_booking_updated_at();

-- ------------------------------------------------------------
-- BOOKING_HISTORY -- append-only audit log, same immutability pattern as
-- listing_history / listing_declarations (prevent_row_mutation(), defined
-- in 20260729000003_listing_declarations_and_history.sql -- reused here,
-- not duplicated).
-- ------------------------------------------------------------
create table if not exists public.booking_history (
  id uuid primary key default uuid_generate_v4(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  actor_user_id uuid references public.profiles(id),
  actor_role text check (actor_role in ('renter', 'merchant', 'system')),
  event_type text not null,
  previous_status booking_status,
  new_status booking_status not null,
  metadata jsonb not null default '{}'::jsonb,
  idempotency_key text,
  created_at timestamptz not null default now()
);

create index if not exists booking_history_booking_idx on public.booking_history(booking_id, created_at);

alter table public.booking_history enable row level security;

create policy "booking_history: parties read"
  on public.booking_history for select
  using (
    exists (
      select 1 from public.bookings
      where bookings.id = booking_history.booking_id
        and (bookings.renter_id = auth.uid() or bookings.merchant_id = auth.uid())
    )
  );

-- No insert/update/delete policy for authenticated/anon -- written only
-- by the service-role-executed RPCs. The trigger below blocks mutation
-- outright regardless of role.
drop trigger if exists prevent_booking_history_mutation on public.booking_history;
create trigger prevent_booking_history_mutation
  before update or delete on public.booking_history
  for each row execute procedure public.prevent_row_mutation();
