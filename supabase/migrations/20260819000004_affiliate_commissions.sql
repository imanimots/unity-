-- ============================================================
-- Step 11 Phase 7 -- affiliate_commissions table
-- ============================================================
-- One row per QUALIFYING PAYMENT EVENT, not per booking/order -- this is
-- what makes "one attribution, many commissions" (e.g. a future rental
-- extension payment) representable, and what "each eligible payment
-- event may create at most one commission" is enforced by at the
-- database level via unique(payment_id), not just application logic.
--
-- No separate affiliate_payouts table -- payout_queued/processing/paid
-- are commission-row states (Decision 12), mirroring how `payments`
-- itself carries its own status through multiple stages without a
-- child "processing" table. Affiliate payouts are always 1:1 with a
-- commission, unlike merchant_payouts (built for a many-bookings-per-
-- payout cardinality that doesn't apply here).
--
-- Every financial value is a snapshot taken once at creation time
-- (eligible_base, commission_rate, commission_amount, currency,
-- calculation_version) -- never recomputed from the live listing rate
-- later, so a merchant changing their rate never rewrites history.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

create table if not exists public.affiliate_commissions (
  id                        uuid primary key default uuid_generate_v4(),
  attribution_id            uuid not null references public.affiliate_attributions(id),
  transaction_type          text not null check (transaction_type in ('sale', 'rental')),
  order_id                  uuid references public.orders(id),
  booking_id                uuid references public.bookings(id),
  payment_id                uuid not null references public.payments(id),
  listing_id                uuid not null references public.listings(id),
  merchant_id               uuid not null references public.profiles(id),
  affiliate_id              uuid not null references public.profiles(id),
  referred_user_id          uuid not null references public.profiles(id),
  eligible_base             numeric(12,2) not null check (eligible_base >= 0),
  commission_rate           numeric(5,2) not null check (commission_rate >= 0),
  commission_amount         numeric(12,2) not null check (commission_amount >= 0),
  currency                  text not null default 'ZAR',
  calculation_version       int not null default 1,
  status                    public.affiliate_commission_status not null default 'pending',
  payout_provider           text,
  payout_provider_reference text,
  payout_requested_at       timestamptz,
  payout_confirmed_at       timestamptz,
  hold_reason               text,
  void_reason               text,
  approved_at               timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  constraint affiliate_commissions_one_transaction_chk check (
    (order_id is not null and booking_id is null)
    or
    (order_id is null and booking_id is not null)
  ),
  constraint affiliate_commissions_payment_unique unique (payment_id)
);

create index if not exists affiliate_commissions_affiliate_idx on public.affiliate_commissions(affiliate_id);
create index if not exists affiliate_commissions_merchant_idx on public.affiliate_commissions(merchant_id);
create index if not exists affiliate_commissions_listing_idx on public.affiliate_commissions(listing_id);
create index if not exists affiliate_commissions_status_idx on public.affiliate_commissions(status);

create or replace function public.touch_affiliate_commission_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists affiliate_commissions_touch_updated_at on public.affiliate_commissions;
create trigger affiliate_commissions_touch_updated_at
  before update on public.affiliate_commissions
  for each row execute function public.touch_affiliate_commission_updated_at();

alter table public.affiliate_commissions enable row level security;

-- Zero client write policies -- every mutation goes through the
-- SECURITY DEFINER RPCs in the RPC migration below.
create policy "affiliate_commissions: affiliate read"
  on public.affiliate_commissions for select
  using (affiliate_id = auth.uid());

create policy "affiliate_commissions: merchant read"
  on public.affiliate_commissions for select
  using (merchant_id = auth.uid());
