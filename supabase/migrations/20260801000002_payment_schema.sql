-- ============================================================
-- Payment domain schema (Phase 2C)
-- ============================================================
-- Six tables, each covering a distinct concern the task's own domain
-- description calls for. A separate transaction_references table was
-- considered and deliberately not built -- a provider_reference text
-- column on the tables that need one is sufficient; a dedicated table
-- would be tracking nothing a foreign key doesn't already give for free.
-- deposit_authorizations was also considered and folded into payments
-- via payment_type ('deposit' | 'rental_charge') sharing one status
-- machine, since the task's own suggested payment_status list (pending,
-- authorised, captured, released, refunded, ...) already covers both a
-- deposit's authorise/release/capture path and a rental charge's
-- pending/capture path in one enum -- two tables would have meant
-- duplicating the same state machine twice.
--
-- No money moves in this phase. These tables model the domain; nothing
-- here calls a real payment provider.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

create table if not exists public.payments (
  id uuid primary key default uuid_generate_v4(),
  booking_id uuid not null references public.bookings(id),
  renter_id uuid not null references public.profiles(id),
  merchant_id uuid not null references public.profiles(id),
  payment_type payment_type not null,
  status payment_status not null default 'pending',
  amount numeric(12,2) not null check (amount >= 0),
  currency text not null default 'ZAR',
  provider text not null,
  provider_reference text,
  idempotency_key text,
  version int not null default 1,
  failure_reason text,
  metadata jsonb not null default '{}'::jsonb,
  requested_at timestamptz not null default now(),
  authorised_at timestamptz,
  captured_at timestamptz,
  released_at timestamptz,
  refunded_at timestamptz,
  cancelled_at timestamptz,
  expired_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint payments_booking_type_unique unique (booking_id, payment_type)
);

create table if not exists public.payment_attempts (
  id uuid primary key default uuid_generate_v4(),
  payment_id uuid not null references public.payments(id),
  attempt_number int not null,
  provider text not null,
  status text not null check (status in ('pending', 'succeeded', 'failed')),
  provider_reference text,
  failure_code text,
  failure_message text,
  created_at timestamptz not null default now(),
  constraint payment_attempts_unique unique (payment_id, attempt_number)
);

create table if not exists public.payment_events (
  id uuid primary key default uuid_generate_v4(),
  payment_id uuid not null references public.payments(id),
  actor_type text not null check (actor_type in ('system', 'webhook', 'api')),
  event_type text not null,
  previous_status payment_status,
  new_status payment_status not null,
  metadata jsonb not null default '{}'::jsonb,
  idempotency_key text,
  created_at timestamptz not null default now()
);

create table if not exists public.refunds (
  id uuid primary key default uuid_generate_v4(),
  payment_id uuid not null references public.payments(id),
  amount numeric(12,2) not null check (amount >= 0),
  reason text,
  status refund_status not null default 'pending',
  provider_reference text,
  idempotency_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.merchant_payouts (
  id uuid primary key default uuid_generate_v4(),
  merchant_id uuid not null references public.profiles(id),
  booking_id uuid references public.bookings(id),
  amount numeric(12,2) not null check (amount >= 0),
  status payout_status not null default 'pending',
  provider_reference text,
  idempotency_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Append-only, immutable. Never updated in place -- a mistaken entry is
-- corrected with an offsetting reversal entry (reversal_of), never edited.
create table if not exists public.ledger_entries (
  id uuid primary key default uuid_generate_v4(),
  booking_id uuid references public.bookings(id),
  payment_id uuid references public.payments(id),
  refund_id uuid references public.refunds(id),
  payout_id uuid references public.merchant_payouts(id),
  merchant_id uuid references public.profiles(id),
  renter_id uuid references public.profiles(id),
  amount numeric(12,2) not null,
  currency text not null default 'ZAR',
  entry_type ledger_entry_type not null,
  reference text,
  reversal_of uuid references public.ledger_entries(id),
  created_at timestamptz not null default now()
);

-- Raw incoming provider webhooks -- untrusted input, kept separate from
-- payment_events (our own internal, trusted record of what happened).
-- The unique constraint is the actual duplicate-event defense; provider +
-- provider_event_id together are how every real payment provider
-- identifies a webhook for replay/dedup purposes.
create table if not exists public.payment_webhook_events (
  id uuid primary key default uuid_generate_v4(),
  provider text not null,
  provider_event_id text not null,
  signature_valid boolean not null,
  payload jsonb not null,
  processing_status text not null default 'received' check (processing_status in ('received', 'processed', 'ignored', 'error')),
  received_at timestamptz not null default now(),
  constraint payment_webhook_events_dedup unique (provider, provider_event_id)
);

create index if not exists payments_booking_idx on public.payments(booking_id);
create index if not exists payments_renter_idx on public.payments(renter_id);
create index if not exists payments_merchant_idx on public.payments(merchant_id);
create index if not exists payments_status_idx on public.payments(status);
create index if not exists payment_attempts_payment_idx on public.payment_attempts(payment_id);
create index if not exists payment_events_payment_idx on public.payment_events(payment_id, created_at);
create index if not exists refunds_payment_idx on public.refunds(payment_id);
create index if not exists merchant_payouts_merchant_idx on public.merchant_payouts(merchant_id, status);
create index if not exists ledger_entries_booking_idx on public.ledger_entries(booking_id);
create index if not exists ledger_entries_payment_idx on public.ledger_entries(payment_id);
create index if not exists ledger_entries_merchant_idx on public.ledger_entries(merchant_id);
create index if not exists ledger_entries_created_idx on public.ledger_entries(created_at);

create or replace function public.touch_payment_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists payments_touch_updated_at on public.payments;
create trigger payments_touch_updated_at
  before update on public.payments
  for each row execute procedure public.touch_payment_updated_at();

drop trigger if exists refunds_touch_updated_at on public.refunds;
create trigger refunds_touch_updated_at
  before update on public.refunds
  for each row execute procedure public.touch_payment_updated_at();

drop trigger if exists merchant_payouts_touch_updated_at on public.merchant_payouts;
create trigger merchant_payouts_touch_updated_at
  before update on public.merchant_payouts
  for each row execute procedure public.touch_payment_updated_at();
