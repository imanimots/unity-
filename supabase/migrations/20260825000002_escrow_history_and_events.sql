-- ============================================================
-- Phase 3 -- Escrow architecture
-- escrow_transaction_history (immutable) + escrow_provider_events
-- (webhook audit/dedup), mirroring merchant_payout_history and
-- payment_webhook_events exactly.
-- ============================================================
-- escrow_provider_events is a SEPARATE table from payment_webhook_events
-- -- escrow is a genuinely distinct financial concern (custody/holding
-- vs. charge processing), and TradeSafe-style events are not payment
-- gateway events. Same (provider, provider_event_id) unique-constraint
-- dedup/replay defense, same "record every event, valid or not, for
-- audit" shape.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

create table if not exists public.escrow_transaction_history (
  id                    uuid primary key default extensions.uuid_generate_v4(),
  escrow_transaction_id uuid not null references public.escrow_transactions(id),
  previous_status       text,
  new_status            text not null,
  actor_type            text not null check (actor_type in ('system', 'admin')),
  actor_id              uuid references public.profiles(id),
  action                text not null,
  reason                text,
  provider_reference    text,
  metadata              jsonb not null default '{}'::jsonb,
  idempotency_key       text,
  created_at            timestamptz not null default now()
);

create index if not exists escrow_transaction_history_escrow_idx on public.escrow_transaction_history(escrow_transaction_id, created_at);

alter table public.escrow_transaction_history enable row level security;
-- Zero client policies -- read only via the audited admin route
-- (mirrors merchant_payout_history's exact precedent: not exposed to
-- participants directly, even for their own escrow transaction).

drop trigger if exists escrow_transaction_history_immutable on public.escrow_transaction_history;
create trigger escrow_transaction_history_immutable
  before update or delete on public.escrow_transaction_history
  for each row execute function public.prevent_row_mutation();

create table if not exists public.escrow_provider_events (
  id                  uuid primary key default extensions.uuid_generate_v4(),
  provider            text not null,
  provider_event_id   text not null,
  signature_valid     boolean not null,
  payload             jsonb not null,
  processing_status   text not null default 'received' check (processing_status in ('received', 'processed', 'ignored', 'error')),
  received_at         timestamptz not null default now(),
  constraint escrow_provider_events_dedup unique (provider, provider_event_id)
);

alter table public.escrow_provider_events enable row level security;
-- Zero client policies -- service-role only, matching payment_webhook_events.
