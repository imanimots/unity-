-- ============================================================
-- Buying & selling checkout — orders schema hardening
-- ============================================================
-- "orders: parties update" (20260720000003) has exactly the same class
-- of bug already fixed for bookings in 20260730000006_booking_security.sql:
-- its USING clause (buyer_id = auth.uid() or seller_id = auth.uid()) lets
-- either party directly PATCH any column via plain PostgREST, including
-- status/total_amount/quantity -- confirmed live, not assumed. Fixed the
-- same way: drop the client-facing update policy entirely (order
-- mutations now go exclusively through service-role RPCs,
-- 20260812000004_order_rpcs.sql), plus the same defense-in-depth
-- trigger pattern as belt-and-suspenders.
--
-- Lifecycle timestamp/audit columns added to match the granularity
-- bookings and barter agreements already have (booking_reference/
-- agreement_reference, requested_at/accepted_at/... equivalents) --
-- orders only had created_at before this.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

create or replace function public.generate_order_reference()
returns text
language sql
as $$
  select 'OR-' || upper(substr(md5(gen_random_uuid()::text), 1, 8));
$$;

alter table public.orders
  add column if not exists order_reference    text unique,
  add column if not exists paid_at            timestamptz,
  add column if not exists shipped_at         timestamptz,
  add column if not exists delivered_at       timestamptz,
  add column if not exists cancelled_at       timestamptz,
  add column if not exists cancelled_by       uuid references public.profiles(id),
  add column if not exists cancellation_reason text;

-- Backfill references for any pre-existing rows (none expected -- no
-- application code has ever written to this table -- but harmless if any
-- exist from manual testing).
update public.orders set order_reference = public.generate_order_reference() where order_reference is null;

alter table public.orders alter column order_reference set not null;
alter table public.orders alter column order_reference set default public.generate_order_reference();

create index if not exists orders_reference_idx on public.orders(order_reference);

-- ─────────────────────────────────────────
-- order_history -- append-only, same shape and shared
-- prevent_row_mutation() trigger as booking_history/barter_history
-- (defined once, 20260729000003_listing_declarations_and_history.sql --
-- reused, not redefined).
-- ─────────────────────────────────────────
create table if not exists public.order_history (
  id              uuid primary key default uuid_generate_v4(),
  order_id        uuid not null references public.orders(id) on delete cascade,
  actor_user_id   uuid references public.profiles(id),
  actor_role      text check (actor_role in ('buyer', 'seller', 'system', 'admin')),
  event_type      text not null,
  previous_status order_status,
  new_status      order_status not null,
  metadata        jsonb not null default '{}'::jsonb,
  idempotency_key text,
  created_at      timestamptz not null default now()
);

create index if not exists order_history_order_idx on public.order_history(order_id, created_at);

alter table public.order_history enable row level security;

create policy "order_history: parties read"
  on public.order_history for select
  using (
    exists (
      select 1 from public.orders
      where orders.id = order_history.order_id
        and (orders.buyer_id = auth.uid() or orders.seller_id = auth.uid())
    )
  );

drop trigger if exists prevent_order_history_mutation on public.order_history;
create trigger prevent_order_history_mutation
  before update or delete on public.order_history
  for each row execute procedure public.prevent_row_mutation();

-- ─────────────────────────────────────────
-- Drop the unsafe client-write policy; every order mutation now goes
-- through a service-role RPC.
-- ─────────────────────────────────────────
drop policy if exists "orders: parties update" on public.orders;

-- ─────────────────────────────────────────
-- protect_order_privileged_fields -- same shape as
-- protect_booking_privileged_fields: INSERT hard-blocked for
-- non-service-role callers (order creation goes through create_order()
-- only), UPDATE silently reverts every privileged column to OLD.
-- ─────────────────────────────────────────
create or replace function public.protect_order_privileged_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then
    if TG_OP = 'INSERT' then
      raise exception 'orders must be created via the create_order RPC, not a direct insert';
    else
      new.order_reference      := old.order_reference;
      new.listing_id            := old.listing_id;
      new.buyer_id               := old.buyer_id;
      new.seller_id              := old.seller_id;
      new.quantity                := old.quantity;
      new.unit_price               := old.unit_price;
      new.shipping_fee              := old.shipping_fee;
      new.total_amount               := old.total_amount;
      new.status                      := old.status;
      new.paid_at                      := old.paid_at;
      new.shipped_at                    := old.shipped_at;
      new.delivered_at                   := old.delivered_at;
      new.cancelled_at                    := old.cancelled_at;
      new.cancelled_by                     := old.cancelled_by;
      new.cancellation_reason               := old.cancellation_reason;
      new.affiliate_id                       := old.affiliate_id;
      new.affiliate_commission_amount         := old.affiliate_commission_amount;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_order_privileged_fields_trg on public.orders;
create trigger protect_order_privileged_fields_trg
  before insert or update on public.orders
  for each row execute procedure public.protect_order_privileged_fields();
