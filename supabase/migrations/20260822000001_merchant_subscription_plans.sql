-- ============================================================
-- Unity Phase 1 -- Merchant Subscriptions & Economics
-- Plan catalogue: the ONE authoritative source for Starter/Pro/Elite
-- commercial terms. Every consumer (dashboard, admin, economics
-- calculator, future Phase 2 commission engine) reads rates from this
-- table -- rates are never hardcoded a second time anywhere else.
--
-- Rates use integer basis points (1/100 of a percent, e.g. 600 = 6.00%)
-- and monthly fees use integer minor currency units (cents) -- no
-- floating-point money anywhere in this schema.
--
-- Stable identifiers ('starter'/'pro'/'elite') are the primary key, not
-- display labels -- display_name can change without ever touching a
-- foreign key.
--
-- Barter commission is hard-enforced at 0 via a CHECK constraint, not
-- just convention -- "Barter remains commission-free for all plans" is
-- a genuine schema-level invariant here.
-- ============================================================

create table if not exists public.merchant_subscription_plans (
  id                       text primary key check (id in ('starter', 'pro', 'elite')),
  display_name             text not null,
  monthly_fee_cents        integer not null check (monthly_fee_cents >= 0),
  currency                 text not null default 'ZAR',
  sales_commission_bps     integer not null check (sales_commission_bps between 0 and 10000),
  rental_commission_bps    integer not null check (rental_commission_bps between 0 and 10000),
  barter_commission_bps    integer not null default 0 check (barter_commission_bps = 0),
  plan_rank                smallint not null unique check (plan_rank >= 0),
  -- null = unlimited. Lives here, not hardcoded in the activation RPC,
  -- so the entitlement stays part of the one authoritative plan model.
  active_listing_limit     integer check (active_listing_limit is null or active_listing_limit > 0),
  is_active                boolean not null default true,
  -- Bumped only if Unity ever changes the commercial terms of an
  -- existing plan id -- lets Phase 2's historical snapshot logic tell
  -- "same plan id, different era" apart from "same plan id, same terms
  -- the whole time." Phase 1 ships exactly one version of each plan.
  commercial_version       integer not null default 1,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create or replace function public.touch_merchant_subscription_plan_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger merchant_subscription_plans_touch_updated_at
  before update on public.merchant_subscription_plans
  for each row execute procedure public.touch_merchant_subscription_plan_updated_at();

alter table public.merchant_subscription_plans enable row level security;

-- Public catalogue -- every authenticated (and unauthenticated, for the
-- public /pricing page) reader may see plan terms. No client write path
-- exists at all; only migrations seed/change this table.
create policy "merchant_subscription_plans: public read active"
  on public.merchant_subscription_plans for select
  using (is_active = true);

create policy "merchant_subscription_plans: admin read all"
  on public.merchant_subscription_plans for select
  using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));

insert into public.merchant_subscription_plans
  (id, display_name, monthly_fee_cents, currency, sales_commission_bps, rental_commission_bps, barter_commission_bps, plan_rank, active_listing_limit)
values
  ('starter', 'Starter', 0,     'ZAR', 600, 1200, 0, 0, 5),
  ('pro',     'Pro Merchant', 19900, 'ZAR', 500, 1000, 0, 1, null),
  ('elite',   'Elite Merchant', 49900, 'ZAR', 400, 800,  0, 2, null)
on conflict (id) do update set
  display_name = excluded.display_name,
  monthly_fee_cents = excluded.monthly_fee_cents,
  currency = excluded.currency,
  sales_commission_bps = excluded.sales_commission_bps,
  rental_commission_bps = excluded.rental_commission_bps,
  barter_commission_bps = excluded.barter_commission_bps,
  plan_rank = excluded.plan_rank,
  active_listing_limit = excluded.active_listing_limit;
