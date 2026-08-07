-- ============================================================
-- Step 11 Phase 8 -- merchant_payout_history (immutable, append-only)
-- ============================================================
-- Reuses prevent_row_mutation() directly, the same trigger every other
-- immutable-history table in this codebase already uses (dispute_history,
-- barter_history, order_history, affiliate_commission_history). One row
-- per genuine transition, written by the shared _merchant_payout_transition()
-- helper (20260820000003) inside the same transaction as the status write.
--
-- payout_id's FK deliberately uses the default NO ACTION (never CASCADE)
-- -- a payout row must not be deletable in a way that could cascade-erase
-- its own immutable history. Nothing in this codebase deletes a payout
-- row today, but the constraint itself is the actual guarantee, not the
-- absence of a delete code path (matches the identical, live-tested
-- guarantee already proven for affiliate_commission_history in Phase 7).
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

create table if not exists public.merchant_payout_history (
  id uuid primary key default uuid_generate_v4(),
  payout_id uuid not null references public.merchant_payouts(id),
  booking_id uuid,
  merchant_id uuid,
  previous_status text,
  new_status text not null,
  actor_type text not null check (actor_type in ('system', 'admin', 'provider')),
  actor_id uuid,
  action text not null,
  reason text,
  failure_category text,
  payout_reference text,
  metadata jsonb not null default '{}'::jsonb,
  idempotency_key text,
  created_at timestamptz not null default now()
);

create index if not exists merchant_payout_history_payout_idx on public.merchant_payout_history(payout_id, created_at);

alter table public.merchant_payout_history enable row level security;
-- Deliberately zero client policies -- admin access is read-only via a
-- service-role admin route (mirrors affiliate_commission_history exactly),
-- never exposed to merchants directly even for their own payouts.

drop trigger if exists prevent_merchant_payout_history_mutation on public.merchant_payout_history;
create trigger prevent_merchant_payout_history_mutation
  before update or delete on public.merchant_payout_history
  for each row execute procedure public.prevent_row_mutation();
