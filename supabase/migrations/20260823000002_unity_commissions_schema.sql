-- ============================================================
-- Unity Phase 2 -- Commission Framework
-- unity_commissions: one row per QUALIFYING PAYMENT EVENT (mirrors
-- affiliate_commissions' exact shape and reasoning -- unique(payment_id)
-- is what makes "each eligible payment event may create at most one
-- commission" a database-level guarantee, not just application logic,
-- and is what lets a future rental extension/recurring-payment feature
-- produce its own additional commission with zero further schema
-- changes here).
--
-- Every financial value is a snapshot taken once at qualification time
-- -- merchant_plan_id, plan_commercial_version, standard_rate,
-- standard_rate_base, excess_rate, excess_base, commission_amount --
-- never recomputed from the live plan later. A merchant changing plans
-- tomorrow must never change yesterday's commission (Phase 2 Step G).
--
-- high-value split fields (standard_rate_base/excess_rate/excess_base)
-- are always populated (excess defaults to 0/0) even for rentals and
-- low-value sales, so the shape is uniform and auditable regardless of
-- transaction kind, rather than nullable-and-sometimes-absent.
-- ============================================================

create table if not exists public.unity_commissions (
  id                     uuid primary key default gen_random_uuid(),
  transaction_type       text not null check (transaction_type in ('sale', 'rental')),
  order_id               uuid references public.orders(id),
  booking_id             uuid references public.bookings(id),
  payment_id             uuid not null references public.payments(id),
  listing_id             uuid not null references public.listings(id),
  merchant_id            uuid not null references public.profiles(id),
  merchant_plan_id       text not null references public.merchant_subscription_plans(id),
  plan_commercial_version integer not null,
  eligible_base          numeric(12,2) not null check (eligible_base >= 0),
  standard_rate_bps      integer not null check (standard_rate_bps >= 0),
  standard_rate_base     numeric(12,2) not null check (standard_rate_base >= 0),
  excess_rate_bps        integer not null default 0 check (excess_rate_bps >= 0),
  excess_base            numeric(12,2) not null default 0 check (excess_base >= 0),
  commission_amount      numeric(12,2) not null check (commission_amount >= 0),
  currency               text not null default 'ZAR',
  calculation_version    integer not null default 1,
  status                 public.unity_commission_status not null default 'pending',
  hold_reason            text,
  void_reason            text,
  earned_at              timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint unity_commissions_one_transaction_chk check (
    (order_id is not null and booking_id is null)
    or
    (order_id is null and booking_id is not null)
  ),
  constraint unity_commissions_payment_unique unique (payment_id)
);

create index if not exists unity_commissions_merchant_idx on public.unity_commissions(merchant_id);
create index if not exists unity_commissions_listing_idx on public.unity_commissions(listing_id);
create index if not exists unity_commissions_status_idx on public.unity_commissions(status);
create index if not exists unity_commissions_order_idx on public.unity_commissions(order_id) where order_id is not null;
create index if not exists unity_commissions_booking_idx on public.unity_commissions(booking_id) where booking_id is not null;

create or replace function public.touch_unity_commission_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists unity_commissions_touch_updated_at on public.unity_commissions;
create trigger unity_commissions_touch_updated_at
  before update on public.unity_commissions
  for each row execute function public.touch_unity_commission_updated_at();

alter table public.unity_commissions enable row level security;

-- Zero client write policies -- every mutation goes through the
-- SECURITY DEFINER RPCs in later migrations, matching every other
-- financial-authority table in this codebase (affiliate_commissions,
-- barter_agreements, disputes, merchant_subscriptions).
create policy "unity_commissions: merchant read"
  on public.unity_commissions for select
  using (merchant_id = auth.uid());

create policy "unity_commissions: admin read"
  on public.unity_commissions for select
  using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));

-- ─────────────────────────────────────────
-- UNITY_COMMISSION_HISTORY -- immutable, append-only. Same shape as
-- affiliate_commission_history/dispute_history/order_history: one log
-- for both routine progression and admin overrides, actor_type/actor_id
-- derived from the row, never a client-claimed value.
-- ─────────────────────────────────────────
create table if not exists public.unity_commission_history (
  id                   uuid primary key default gen_random_uuid(),
  commission_id        uuid not null references public.unity_commissions(id) on delete cascade,
  payment_id           uuid references public.payments(id),
  previous_status      text,
  new_status           text not null,
  actor_type           text not null check (actor_type in ('system', 'admin')),
  actor_id             uuid references public.profiles(id),
  reason               text,
  calculation_snapshot jsonb not null default '{}'::jsonb,
  idempotency_key      text,
  created_at           timestamptz not null default now()
);

create index if not exists unity_commission_history_commission_idx on public.unity_commission_history(commission_id, created_at);

alter table public.unity_commission_history enable row level security;

create policy "unity_commission_history: merchant read"
  on public.unity_commission_history for select
  using (
    exists (
      select 1 from public.unity_commissions c
      where c.id = unity_commission_history.commission_id and c.merchant_id = auth.uid()
    )
  );

create policy "unity_commission_history: admin read"
  on public.unity_commission_history for select
  using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));

drop trigger if exists unity_commission_history_immutable on public.unity_commission_history;
create trigger unity_commission_history_immutable
  before update or delete on public.unity_commission_history
  for each row execute function public.prevent_row_mutation();

-- ─────────────────────────────────────────
-- UNITY_COMMISSION_ADJUSTMENTS -- append-only. The ONLY way to correct
-- a commission's effective retained amount without ever rewriting the
-- original snapshot row: a signed delta (negative for a partial-refund
-- reduction) referencing the original commission. Mirrors
-- affiliate_commission_adjustments exactly.
-- ─────────────────────────────────────────
create table if not exists public.unity_commission_adjustments (
  id              uuid primary key default gen_random_uuid(),
  commission_id   uuid not null references public.unity_commissions(id),
  amount          numeric(12,2) not null,
  reason          text not null,
  created_by      uuid references public.profiles(id),
  idempotency_key text,
  created_at      timestamptz not null default now()
);

create index if not exists unity_commission_adjustments_commission_idx on public.unity_commission_adjustments(commission_id);

alter table public.unity_commission_adjustments enable row level security;

create policy "unity_commission_adjustments: merchant read"
  on public.unity_commission_adjustments for select
  using (
    exists (
      select 1 from public.unity_commissions c
      where c.id = unity_commission_adjustments.commission_id and c.merchant_id = auth.uid()
    )
  );

create policy "unity_commission_adjustments: admin read"
  on public.unity_commission_adjustments for select
  using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));

drop trigger if exists unity_commission_adjustments_immutable on public.unity_commission_adjustments;
create trigger unity_commission_adjustments_immutable
  before update or delete on public.unity_commission_adjustments
  for each row execute function public.prevent_row_mutation();
