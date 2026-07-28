-- ============================================================
-- Buying & Selling — database design (Phase 1 architecture change)
-- ============================================================
-- Schema only. No application code (API routes, UI, types) has
-- been wired up against these tables/columns yet — that is Phase 2.
-- Rationale and alternatives considered are documented in
-- docs/BUYING_SELLING.md.
-- Apply via: Supabase Dashboard → SQL Editor → Run
-- ============================================================

do $$ begin
  create type listing_type as enum ('rental', 'sale');
exception when duplicate_object then null; end $$;

do $$ begin
  create type order_status as enum ('pending', 'paid', 'shipped', 'delivered', 'disputed', 'cancelled');
exception when duplicate_object then null; end $$;

-- ─────────────────────────────────────────
-- LISTINGS — extend to cover sale items
-- ─────────────────────────────────────────
alter table public.listings
  add column if not exists listing_type      listing_type not null default 'rental',
  add column if not exists sale_price         numeric(10,2),
  add column if not exists quantity_available int not null default 1;

alter table public.listings
  alter column daily_rate drop not null;

alter table public.listings
  add constraint listings_type_pricing_chk check (
    (listing_type = 'rental' and daily_rate is not null and sale_price is null)
    or
    (listing_type = 'sale' and sale_price is not null and daily_rate is null)
  );

create index if not exists listings_type_idx on public.listings(listing_type);

-- ─────────────────────────────────────────
-- ORDERS — one-time purchases (parallel to bookings, not a merge)
-- ─────────────────────────────────────────
-- Kept separate from `bookings` rather than merged into it: a purchase has no
-- start/end date, no return step, and escrow releases on delivery
-- confirmation rather than return confirmation. Forcing both shapes into one
-- table would mean a large block of nullable, rental-only or sale-only
-- columns on every row. See docs/BUYING_SELLING.md for the trade-off.
create table if not exists public.orders (
  id                          uuid primary key default uuid_generate_v4(),
  listing_id                  uuid not null references public.listings(id),
  buyer_id                    uuid not null references public.profiles(id),
  seller_id                   uuid not null references public.profiles(id),
  quantity                    int not null default 1,
  unit_price                  numeric(10,2) not null,
  shipping_fee                numeric(10,2) not null default 0,
  total_amount                numeric(10,2) not null,
  status                      order_status not null default 'pending',
  pre_sale_media_url          text,
  payfast_payment_id          text,
  affiliate_id                uuid references public.profiles(id),
  affiliate_commission_amount numeric(10,2),
  created_at                  timestamptz not null default now()
);

create index if not exists orders_buyer_idx    on public.orders(buyer_id);
create index if not exists orders_seller_idx   on public.orders(seller_id);
create index if not exists orders_listing_idx  on public.orders(listing_id);
create index if not exists orders_status_idx   on public.orders(status);

alter table public.orders enable row level security;

create policy "orders: parties read"
  on public.orders for select
  using (buyer_id = auth.uid() or seller_id = auth.uid());

create policy "orders: buyer insert"
  on public.orders for insert
  with check (buyer_id = auth.uid());

create policy "orders: parties update"
  on public.orders for update
  using (buyer_id = auth.uid() or seller_id = auth.uid());

-- ─────────────────────────────────────────
-- REVIEWS / DISPUTES / MESSAGES — extend to cover orders
-- ─────────────────────────────────────────
-- Rather than duplicating trust & safety infrastructure per transaction
-- type, these tables become dual-purpose: exactly one of (booking_id,
-- order_id) must be set, enforced by a CHECK constraint, preserving real
-- FK integrity (no loose/polymorphic association).

alter table public.reviews
  add column if not exists order_id uuid references public.orders(id),
  alter column booking_id drop not null;

alter table public.reviews
  add constraint reviews_one_transaction_chk check (
    (booking_id is not null and order_id is null)
    or
    (booking_id is null and order_id is not null)
  );

alter table public.disputes
  add column if not exists order_id uuid references public.orders(id),
  alter column booking_id drop not null;

alter table public.disputes
  add constraint disputes_one_transaction_chk check (
    (booking_id is not null and order_id is null)
    or
    (booking_id is null and order_id is not null)
  );

alter table public.messages
  add column if not exists order_id uuid references public.orders(id),
  alter column booking_id drop not null;

alter table public.messages
  add constraint messages_one_transaction_chk check (
    (booking_id is not null and order_id is null)
    or
    (booking_id is null and order_id is not null)
  );

-- RLS: mirror the existing bookings-party policies for the order_id path.
drop policy if exists "disputes: parties read" on public.disputes;
create policy "disputes: parties read"
  on public.disputes for select
  using (
    raised_by = auth.uid()
    or exists (
      select 1 from public.bookings
      where bookings.id = disputes.booking_id
        and (bookings.renter_id = auth.uid() or bookings.merchant_id = auth.uid())
    )
    or exists (
      select 1 from public.orders
      where orders.id = disputes.order_id
        and (orders.buyer_id = auth.uid() or orders.seller_id = auth.uid())
    )
  );

drop policy if exists "disputes: parties insert" on public.disputes;
create policy "disputes: parties insert"
  on public.disputes for insert
  with check (
    raised_by = auth.uid()
    and (
      exists (
        select 1 from public.bookings
        where bookings.id = disputes.booking_id
          and (bookings.renter_id = auth.uid() or bookings.merchant_id = auth.uid())
      )
      or exists (
        select 1 from public.orders
        where orders.id = disputes.order_id
          and (orders.buyer_id = auth.uid() or orders.seller_id = auth.uid())
      )
    )
  );

drop policy if exists "messages: parties read" on public.messages;
create policy "messages: parties read"
  on public.messages for select
  using (
    exists (
      select 1 from public.bookings
      where bookings.id = messages.booking_id
        and (bookings.renter_id = auth.uid() or bookings.merchant_id = auth.uid())
    )
    or exists (
      select 1 from public.orders
      where orders.id = messages.order_id
        and (orders.buyer_id = auth.uid() or orders.seller_id = auth.uid())
    )
  );

drop policy if exists "messages: parties send" on public.messages;
create policy "messages: parties send"
  on public.messages for insert
  with check (
    sender_id = auth.uid()
    and (
      exists (
        select 1 from public.bookings
        where bookings.id = messages.booking_id
          and (bookings.renter_id = auth.uid() or bookings.merchant_id = auth.uid())
      )
      or exists (
        select 1 from public.orders
        where orders.id = messages.order_id
          and (orders.buyer_id = auth.uid() or orders.seller_id = auth.uid())
      )
    )
  );

-- ─────────────────────────────────────────
-- AFFILIATE REFERRALS — extend to cover orders
-- ─────────────────────────────────────────
alter table public.affiliate_referrals
  add column if not exists order_id uuid references public.orders(id);
