-- ============================================================
-- Phase 5 -- Rent-to-Buy: first-class schema.
-- ============================================================
-- rent_to_buy_agreements is its own first-class transaction table --
-- NOT forced into orders/bookings/barter_agreements (per the brief's
-- explicit mapping: Buy -> order, Rent -> booking, Barter -> barter
-- agreement, Rent-to-Buy -> rent_to_buy_agreement).
--
-- Three independently-tracked state dimensions on the agreement row
-- itself (status/possession_status/ownership_status) -- ownership is
-- NEVER derived from agreement.status (Rule F), and possession is
-- never claimed merely because a payment succeeded (Rule 2/E) -- a
-- separate confirm_rent_to_buy_possession() action (mirrors booking's
-- own financially_ready-vs-started split) is required after the first
-- installment settles.
--
-- rent_to_buy_listing_terms is a dedicated 1:1 table (not new columns
-- on listings) so a listing's RTB commercial terms can carry their own
-- versioning/enable-disable lifecycle independent of the listing row's
-- own moderation/status lifecycle.
--
-- Money: numeric(12,2), matching every existing financial table in
-- this codebase (never floating point).
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

-- ── rent_to_buy_listing_terms ────────────────────────────────
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

create index if not exists rtb_listing_terms_merchant_idx on public.rent_to_buy_listing_terms(merchant_id);
create index if not exists rtb_listing_terms_enabled_idx on public.rent_to_buy_listing_terms(enabled) where enabled = true;

create or replace function public.touch_rtb_listing_terms_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists rtb_listing_terms_touch on public.rent_to_buy_listing_terms;
create trigger rtb_listing_terms_touch before update on public.rent_to_buy_listing_terms
  for each row execute function public.touch_rtb_listing_terms_updated_at();

-- ── rent_to_buy_agreements ───────────────────────────────────
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

  -- Terms snapshot (Rule D) -- an existing listing's terms editing
  -- later must never alter an already-accepted agreement's economics.
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

create index if not exists rtb_agreements_merchant_idx on public.rent_to_buy_agreements(merchant_id);
create index if not exists rtb_agreements_customer_idx on public.rent_to_buy_agreements(customer_id);
create index if not exists rtb_agreements_listing_idx on public.rent_to_buy_agreements(listing_id);
create index if not exists rtb_agreements_status_idx on public.rent_to_buy_agreements(status);

create or replace function public.touch_rtb_agreement_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists rtb_agreements_touch on public.rent_to_buy_agreements;
create trigger rtb_agreements_touch before update on public.rent_to_buy_agreements
  for each row execute function public.touch_rtb_agreement_updated_at();

-- ── rent_to_buy_installments ─────────────────────────────────
create table if not exists public.rent_to_buy_installments (
  id                 uuid primary key default gen_random_uuid(),
  agreement_id       uuid not null references public.rent_to_buy_agreements(id),
  sequence           int not null check (sequence > 0),
  due_date           date not null,
  principal_amount   numeric(12,2) not null check (principal_amount > 0),
  status             public.rent_to_buy_installment_status not null default 'scheduled',
  payment_id         uuid references public.payments(id),
  paid_at            timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint rtb_installments_agreement_sequence_unique unique (agreement_id, sequence)
);

create index if not exists rtb_installments_agreement_idx on public.rent_to_buy_installments(agreement_id);
create index if not exists rtb_installments_status_idx on public.rent_to_buy_installments(status);
create index if not exists rtb_installments_payment_idx on public.rent_to_buy_installments(payment_id) where payment_id is not null;

create or replace function public.touch_rtb_installment_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists rtb_installments_touch on public.rent_to_buy_installments;
create trigger rtb_installments_touch before update on public.rent_to_buy_installments
  for each row execute function public.touch_rtb_installment_updated_at();

-- ── rent_to_buy_history (append-only) ────────────────────────
create table if not exists public.rent_to_buy_history (
  id               uuid primary key default gen_random_uuid(),
  agreement_id     uuid not null references public.rent_to_buy_agreements(id),
  actor_role       text not null check (actor_role in ('merchant', 'customer', 'system', 'admin')),
  actor_id         uuid,
  event_type       text not null,
  previous_status  text,
  new_status       text,
  metadata         jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now()
);

create index if not exists rtb_history_agreement_idx on public.rent_to_buy_history(agreement_id, created_at);

drop trigger if exists rtb_history_immutable on public.rent_to_buy_history;
create trigger rtb_history_immutable
  before update or delete on public.rent_to_buy_history
  for each row execute function public.prevent_row_mutation();

-- ── rent_to_buy_return_cases ──────────────────────────────────
-- Voluntary return AND recovery-case both live in one table
-- (case_type distinguishes them) -- recovery_provider is always
-- 'manual' (provider-neutral architecture only, Rule 6/K -- no real
-- recovery-partner API is ever called).
create table if not exists public.rent_to_buy_return_cases (
  id                 uuid primary key default gen_random_uuid(),
  agreement_id       uuid not null references public.rent_to_buy_agreements(id),
  case_type          public.rent_to_buy_return_case_type not null,
  status             public.rent_to_buy_return_case_status not null default 'requested',
  requested_by       uuid references public.profiles(id),
  requested_at       timestamptz not null default now(),
  scheduled_at       timestamptz,
  condition_notes    text,
  recovery_provider  text check (recovery_provider is null or recovery_provider = 'manual'),
  resolved_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists rtb_return_cases_agreement_idx on public.rent_to_buy_return_cases(agreement_id);

create or replace function public.touch_rtb_return_case_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists rtb_return_cases_touch on public.rent_to_buy_return_cases;
create trigger rtb_return_cases_touch before update on public.rent_to_buy_return_cases
  for each row execute function public.touch_rtb_return_case_updated_at();

-- ── rent_to_buy_commission_events ────────────────────────────
-- Records that a successful installment REACHED the RTB commission
-- qualification boundary (Rule 15/L) without ever computing or storing
-- a real chargeable amount -- rate_status stays 'policy_pending'
-- forever until a future, separately-approved migration introduces a
-- real rate and a real qualify-into-unity_commissions path.
-- unity_commissions.commission_amount is NOT NULL check(>=0) -- it
-- structurally cannot hold an unresolved-rate placeholder, which is
-- exactly why this is its own small table rather than a reused/forced
-- row there (Rule 16 -- never silently choose sale/rental/average rate).
create table if not exists public.rent_to_buy_commission_events (
  id                  uuid primary key default gen_random_uuid(),
  agreement_id        uuid not null references public.rent_to_buy_agreements(id),
  installment_id       uuid not null references public.rent_to_buy_installments(id),
  payment_id            uuid not null references public.payments(id),
  eligible_base          numeric(12,2) not null check (eligible_base >= 0),
  rate_status             text not null default 'policy_pending' check (rate_status = 'policy_pending'),
  commission_amount       numeric(12,2),
  qualified_at             timestamptz not null default now(),
  created_at                timestamptz not null default now(),
  constraint rtb_commission_events_installment_unique unique (installment_id)
);

create index if not exists rtb_commission_events_agreement_idx on public.rent_to_buy_commission_events(agreement_id);

-- ── RLS ────────────────────────────────────────────────────────
alter table public.rent_to_buy_listing_terms enable row level security;
alter table public.rent_to_buy_agreements enable row level security;
alter table public.rent_to_buy_installments enable row level security;
alter table public.rent_to_buy_history enable row level security;
alter table public.rent_to_buy_return_cases enable row level security;
alter table public.rent_to_buy_commission_events enable row level security;

create policy "rtb_listing_terms: public read enabled" on public.rent_to_buy_listing_terms
  for select using (enabled = true);
create policy "rtb_listing_terms: merchant reads own" on public.rent_to_buy_listing_terms
  for select using (merchant_id = auth.uid());
-- Zero client write policies -- every mutation goes through
-- save_rent_to_buy_listing_terms(), SECURITY DEFINER, service-role-only.

create policy "rtb_agreements: merchant reads own" on public.rent_to_buy_agreements
  for select using (merchant_id = auth.uid());
create policy "rtb_agreements: customer reads own" on public.rent_to_buy_agreements
  for select using (customer_id = auth.uid());
-- Zero client write policies -- every mutation is RPC-gated, matching
-- barter_agreements/disputes/marketplace_requests' fully-RPC-gated model.

create policy "rtb_installments: parties read" on public.rent_to_buy_installments
  for select using (
    exists (select 1 from public.rent_to_buy_agreements a
      where a.id = rent_to_buy_installments.agreement_id
        and (a.merchant_id = auth.uid() or a.customer_id = auth.uid()))
  );
-- Zero client write policies.

create policy "rtb_history: parties read" on public.rent_to_buy_history
  for select using (
    exists (select 1 from public.rent_to_buy_agreements a
      where a.id = rent_to_buy_history.agreement_id
        and (a.merchant_id = auth.uid() or a.customer_id = auth.uid()))
  );
-- Zero client write policies (also immutable at the trigger level).

create policy "rtb_return_cases: parties read" on public.rent_to_buy_return_cases
  for select using (
    exists (select 1 from public.rent_to_buy_agreements a
      where a.id = rent_to_buy_return_cases.agreement_id
        and (a.merchant_id = auth.uid() or a.customer_id = auth.uid()))
  );
-- Zero client write policies.

create policy "rtb_commission_events: merchant reads own" on public.rent_to_buy_commission_events
  for select using (
    exists (select 1 from public.rent_to_buy_agreements a
      where a.id = rent_to_buy_commission_events.agreement_id and a.merchant_id = auth.uid())
  );
-- Zero client write policies -- admin/finance visibility only via
-- service-role admin routes, matching every other commission table.
