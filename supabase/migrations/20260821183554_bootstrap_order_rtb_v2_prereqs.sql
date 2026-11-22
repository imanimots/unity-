-- Bootstrap-order correction shim #3 (E50.2B).
--
-- 20260821183555_rtb_v2_schema.sql and its sibling RTB V2 files (dated
-- 2026-08-21, actually applied to development later -- same
-- out-of-order mechanism as Subscription V2) ALTER or FK-reference four
-- objects that, on a clean filename-order bootstrap, do not exist yet:
-- rent_to_buy_listing_terms, rent_to_buy_agreements, unity_commissions,
-- escrow_transactions. This migration creates ONLY the baseline shape
-- each object's own later authoritative migration originally
-- established -- never the evolved final shape -- so each of those
-- later `create table if not exists` statements cleanly no-ops when it
-- runs at its normal position, and every later ALTER still applies
-- exactly as before. Column lists are copied verbatim from the
-- authoritative source migrations named in each section below.
--
-- Note: rent_to_buy_frequency/agreement_status/possession_status/
-- ownership_status/unity_commission_status are enums whose OWN
-- authoritative creation migrations (20260827000002, 20260823000001)
-- are also dated after this shim's position, so they are reproduced
-- here too. rent_to_buy_possession_trigger_type and rent_to_buy_rate_
-- unit are NOT included -- those are genuinely NEW types that
-- 20260821183555 itself creates (confirmed: not present in any earlier
-- migration), so they have no forward-reference problem and are left
-- entirely alone.
--
-- Deliberately excluded (not needed to satisfy the forward DDL
-- dependency itself; left to run normally at their original position):
--   - rent_to_buy_installments, rent_to_buy_history,
--     rent_to_buy_return_cases, rent_to_buy_commission_events,
--     unity_commission_history, unity_commission_adjustments,
--     escrow_transaction_history, escrow_provider_events (only
--     referenced via INSERT INTO inside deferred plpgsql function
--     bodies in the RTB V2 files -- harmless until actually called)
--   - every secondary index, trigger, RLS policy, grant, and seed-data
--     statement from the four objects' authoritative migrations
--
-- Transitive dependencies already satisfied by this point in the
-- chain: `profiles`, `listings`, `orders`, `bookings`, `payments`
-- (all pre-Phase-1/early), `barter_agreements` (2026-08-10),
-- `marketplace_requests` + `marketplace_request_offers` (shim #1,
-- 20260819000012), `merchant_subscription_plans` (shim #2,
-- 20260819072043 -- sorts before this file).

do $$
begin
  -- From 20260827000002_rtb_status_enums.sql (subset actually needed)
  if not exists (select 1 from pg_type where typname = 'rent_to_buy_agreement_status') then
    create type rent_to_buy_agreement_status as enum (
      'pending_merchant_acceptance',
      'awaiting_first_payment',
      'active',
      'defaulted',
      'return_required',
      'completed',
      'cancelled',
      'disputed'
    );
  end if;
  if not exists (select 1 from pg_type where typname = 'rent_to_buy_possession_status') then
    create type rent_to_buy_possession_status as enum (
      'not_delivered',
      'possession_eligible',
      'customer_in_possession',
      'return_required',
      'return_in_progress',
      'returned_to_merchant',
      'recovered'
    );
  end if;
  if not exists (select 1 from pg_type where typname = 'rent_to_buy_ownership_status') then
    create type rent_to_buy_ownership_status as enum (
      'merchant_owned',
      'customer_owned'
    );
  end if;
  if not exists (select 1 from pg_type where typname = 'rent_to_buy_frequency') then
    create type rent_to_buy_frequency as enum ('weekly', 'biweekly', 'monthly');
  end if;
  -- From 20260823000001_unity_commission_status_enum.sql
  if not exists (select 1 from pg_type where typname = 'unity_commission_status') then
    create type public.unity_commission_status as enum (
      'pending',
      'held',
      'earned',
      'adjusted',
      'voided'
    );
  end if;
  -- From 20260825000001_escrow_schema.sql
  if not exists (select 1 from pg_type where typname = 'escrow_status') then
    create type escrow_status as enum ('pending', 'funded', 'released', 'refunded', 'partially_refunded', 'cancelled', 'failed');
  end if;
end$$;

-- ── rent_to_buy_listing_terms ── baseline from 20260827000003 ────────
create table if not exists public.rent_to_buy_listing_terms (
  id                       uuid primary key default gen_random_uuid(),
  listing_id               uuid not null unique references public.listings(id),
  merchant_id              uuid not null references public.profiles(id),
  enabled                  boolean not null default false,
  currency                 text not null default 'ZAR',
  total_purchase_price     numeric(12,2) not null check (total_purchase_price > 0),
  installment_amount       numeric(12,2) not null check (installment_amount > 0),
  payment_frequency        public.rent_to_buy_frequency not null,
  installment_count        int not null check (installment_count > 0 and installment_count <= 520),
  security_deposit_amount  numeric(12,2) check (security_deposit_amount is null or security_deposit_amount >= 0),
  early_payoff_allowed     boolean not null default false,
  early_payoff_policy      jsonb,
  default_cure_allowed     boolean not null default false,
  cure_policy              jsonb,
  terms_version            int not null default 1,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

-- ── rent_to_buy_agreements ── baseline from 20260827000003 ───────────
create table if not exists public.rent_to_buy_agreements (
  id                          uuid primary key default gen_random_uuid(),
  listing_id                  uuid not null references public.listings(id),
  merchant_id                 uuid not null references public.profiles(id),
  customer_id                 uuid not null references public.profiles(id),
  request_id                  uuid references public.marketplace_requests(id),
  offer_id                    uuid references public.marketplace_request_offers(id),

  status                      public.rent_to_buy_agreement_status not null default 'pending_merchant_acceptance',
  possession_status           public.rent_to_buy_possession_status not null default 'not_delivered',
  ownership_status            public.rent_to_buy_ownership_status not null default 'merchant_owned',

  currency                    text not null default 'ZAR',
  total_purchase_price        numeric(12,2) not null check (total_purchase_price > 0),
  installment_amount          numeric(12,2) not null check (installment_amount > 0),
  payment_frequency           public.rent_to_buy_frequency not null,
  installment_count           int not null check (installment_count > 0),
  security_deposit_amount     numeric(12,2),
  early_payoff_allowed        boolean not null default false,
  early_payoff_policy         jsonb,
  cure_allowed                boolean not null default false,
  cure_policy                 jsonb,
  terms_version                int not null default 1,

  first_due_date               date,
  final_due_date                date,

  accepted_at                  timestamptz,
  first_payment_settled_at     timestamptz,
  possession_confirmed_at      timestamptz,
  ownership_transferred_at     timestamptz,

  default_at                   timestamptz,
  default_reason                text,
  default_reconciliation_pending boolean not null default false,

  cancelled_at                  timestamptz,
  cancelled_reason               text,

  is_test                        boolean not null default false,
  created_at                     timestamptz not null default now(),
  updated_at                     timestamptz not null default now()
);

-- ── unity_commissions ── baseline from 20260823000002 ─────────────────
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

-- ── escrow_transactions ── baseline from 20260825000001 ──────────────
create table if not exists public.escrow_transactions (
  id                            uuid primary key default extensions.uuid_generate_v4(),
  transaction_type              text not null check (transaction_type in ('sale', 'rental', 'barter')),

  order_id                      uuid references public.orders(id),
  booking_id                    uuid references public.bookings(id),
  barter_agreement_id           uuid references public.barter_agreements(id),

  payment_id                    uuid references public.payments(id),

  status                        escrow_status not null default 'pending',
  provider                      text not null,
  provider_reference            text,

  principal_amount              numeric(12,2) not null check (principal_amount >= 0),
  secure_transaction_fee_amount numeric(12,2) not null default 0 check (secure_transaction_fee_amount >= 0),
  fee_payer                     text not null default 'platform' check (fee_payer in ('payer', 'recipient', 'platform')),
  currency                      text not null default 'ZAR',

  released_to                   uuid references public.profiles(id),
  release_reason                text,
  refunded_amount                numeric(12,2) not null default 0 check (refunded_amount >= 0),

  funded_at                     timestamptz,
  released_at                   timestamptz,
  refunded_at                   timestamptz,
  cancelled_at                  timestamptz,

  failure_reason                text,
  idempotency_key                text,
  version                       int not null default 1,
  metadata                      jsonb not null default '{}'::jsonb,
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),

  constraint escrow_transactions_one_transaction_chk check (
    (booking_id is not null and order_id is null and barter_agreement_id is null)
    or (booking_id is null and order_id is not null and barter_agreement_id is null)
    or (booking_id is null and order_id is null and barter_agreement_id is not null)
  ),
  constraint escrow_transactions_payment_unique unique (payment_id)
);
