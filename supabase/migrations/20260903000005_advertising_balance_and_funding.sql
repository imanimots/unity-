-- Advertising MVP -- Phase 5: Advertising Balance + campaign funding.
--
-- ABSOLUTE RULE (binding): the Advertising Balance is NOT withdrawable as
-- cash. No cash-out route, no merchant-payout integration, no escrow
-- integration, no transfer to another advertiser. It may only fund future
-- Unity Advertising purchases. Deterministic integer-cent accounting
-- throughout (never floating point), matching the binding underdelivery-
-- credit formula's own requirement.
--
-- Mirrors this codebase's established immutable-ledger convention
-- exactly: a mutable "current balance" table + an append-only ledger
-- table distinguishing funding_credit / campaign_purchase_debit /
-- underdelivery_credit / preactivation_refund_to_balance /
-- admin_adjustment / invalid_delivery_adjustment as genuinely separate
-- concepts. No balance may go silently negative -- enforced by both a
-- CHECK constraint and (in the RPC layer, next migrations) a row-locked
-- check-then-write.
--
-- Deliberately its own schema, never joined into `payments` /
-- `ledger_entries` / `merchant_payouts` / EscrowProvider -- advertising
-- money is structurally incapable of being swept into transaction
-- escrow, merchant payout, commission, or affiliate calculations.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'ad_ledger_entry_type') then
    create type ad_ledger_entry_type as enum (
      'funding_credit',
      'campaign_purchase_debit',
      'underdelivery_credit',
      'preactivation_refund_to_balance',
      'admin_adjustment',
      'invalid_delivery_adjustment'
    );
  end if;
  if not exists (select 1 from pg_type where typname = 'ad_funding_source') then
    create type ad_funding_source as enum ('balance', 'provider');
  end if;
  if not exists (select 1 from pg_type where typname = 'ad_funding_status') then
    create type ad_funding_status as enum ('completed', 'refunded');
  end if;
end$$;

create table if not exists public.ad_balance_accounts (
  id             uuid primary key default gen_random_uuid(),
  advertiser_id  uuid not null unique references public.ad_advertisers(id),
  balance_cents  integer not null default 0 check (balance_cents >= 0),
  currency       text not null default 'ZAR',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table public.ad_balance_accounts enable row level security;

create policy "ad_balance_accounts: owner read"
  on public.ad_balance_accounts for select
  using (exists (select 1 from public.ad_advertisers a where a.id = ad_balance_accounts.advertiser_id and a.owner_profile_id = auth.uid()));

create policy "ad_balance_accounts: admin read"
  on public.ad_balance_accounts for select
  using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));

-- ── ad_balance_ledger ── immutable, append-only ────────────────────────
create table if not exists public.ad_balance_ledger (
  id                  uuid primary key default gen_random_uuid(),
  account_id          uuid not null references public.ad_balance_accounts(id),
  campaign_id         uuid references public.ad_campaigns(id),
  entry_type          ad_ledger_entry_type not null,
  amount_cents        integer not null,
  balance_after_cents integer not null check (balance_after_cents >= 0),
  actor_type          text not null check (actor_type in ('system', 'advertiser', 'admin')),
  actor_id            uuid references public.profiles(id),
  reason              text,
  idempotency_key     text,
  created_at          timestamptz not null default now(),
  -- Sign consistency per entry type -- credits are positive, the
  -- purchase debit is negative; admin/invalid-delivery adjustments are
  -- corrections and may legitimately go either way.
  constraint ad_balance_ledger_sign_matches_type check (
    (entry_type in ('funding_credit', 'underdelivery_credit', 'preactivation_refund_to_balance') and amount_cents > 0)
    or (entry_type = 'campaign_purchase_debit' and amount_cents < 0)
    or (entry_type in ('admin_adjustment', 'invalid_delivery_adjustment'))
  )
);

create index if not exists ad_balance_ledger_account_idx on public.ad_balance_ledger(account_id, created_at);
create index if not exists ad_balance_ledger_campaign_idx on public.ad_balance_ledger(campaign_id) where campaign_id is not null;
create unique index if not exists ad_balance_ledger_idempotency_idx on public.ad_balance_ledger(account_id, idempotency_key) where idempotency_key is not null;

alter table public.ad_balance_ledger enable row level security;

create policy "ad_balance_ledger: owner read"
  on public.ad_balance_ledger for select
  using (exists (
    select 1 from public.ad_balance_accounts acc
    join public.ad_advertisers a on a.id = acc.advertiser_id
    where acc.id = ad_balance_ledger.account_id and a.owner_profile_id = auth.uid()
  ));

create policy "ad_balance_ledger: admin read"
  on public.ad_balance_ledger for select
  using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));

drop trigger if exists ad_balance_ledger_immutable on public.ad_balance_ledger;
create trigger ad_balance_ledger_immutable
  before update or delete on public.ad_balance_ledger
  for each row execute procedure public.prevent_row_mutation();

-- ── ad_campaign_funding ── one row per campaign's funding event ───────
-- Records HOW a specific campaign was funded (balance debit vs the mock
-- provider-neutral AdvertisingBillingProvider), independent of whether
-- the advertiser's balance account is ever touched at all (a
-- provider-funded campaign never creates a balance-ledger row unless it
-- is later refunded TO the balance under the balance-funded refund
-- rule -- provider-funded refunds return to the provider, not to
-- balance, per the binding "refund must return to the ORIGINAL FUNDING
-- SOURCE" rule).
create table if not exists public.ad_campaign_funding (
  id                 uuid primary key default gen_random_uuid(),
  campaign_id        uuid not null unique references public.ad_campaigns(id),
  funding_source     ad_funding_source not null,
  amount_cents       integer not null check (amount_cents > 0),
  provider_reference text,
  status             ad_funding_status not null default 'completed',
  funded_at          timestamptz not null default now(),
  refunded_at        timestamptz,
  refund_reason      text,
  created_at         timestamptz not null default now()
);

create index if not exists ad_campaign_funding_campaign_idx on public.ad_campaign_funding(campaign_id);

alter table public.ad_campaign_funding enable row level security;

create policy "ad_campaign_funding: owner read"
  on public.ad_campaign_funding for select
  using (exists (
    select 1 from public.ad_campaigns c
    join public.ad_advertisers a on a.id = c.advertiser_id
    where c.id = ad_campaign_funding.campaign_id and a.owner_profile_id = auth.uid()
  ));

create policy "ad_campaign_funding: admin read"
  on public.ad_campaign_funding for select
  using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));
