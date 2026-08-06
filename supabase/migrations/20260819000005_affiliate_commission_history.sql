-- ============================================================
-- Step 11 Phase 7 -- affiliate_commission_history (immutable, append-only)
-- ============================================================
-- Reuses prevent_row_mutation() (defined once, 20260729000003) --
-- never redefined. Same shape as dispute_history/order_history/
-- barter_history: one append-only log for both routine progression and
-- admin overrides, actor_type/actor_id derived from the row, never a
-- client-claimed value.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

create table if not exists public.affiliate_commission_history (
  id                   uuid primary key default uuid_generate_v4(),
  commission_id        uuid not null references public.affiliate_commissions(id) on delete cascade,
  attribution_id       uuid references public.affiliate_attributions(id),
  listing_id           uuid references public.listings(id),
  payment_id           uuid references public.payments(id),
  previous_status      text,
  new_status           text not null,
  actor_type           text not null check (actor_type in ('system', 'admin')),
  actor_id             uuid references public.profiles(id),
  reason               text,
  calculation_snapshot jsonb not null default '{}'::jsonb,
  provider_reference   text,
  idempotency_key      text,
  created_at           timestamptz not null default now()
);

create index if not exists affiliate_commission_history_commission_idx on public.affiliate_commission_history(commission_id, created_at);

alter table public.affiliate_commission_history enable row level security;

create policy "affiliate_commission_history: affiliate read"
  on public.affiliate_commission_history for select
  using (
    exists (
      select 1 from public.affiliate_commissions c
      where c.id = affiliate_commission_history.commission_id and c.affiliate_id = auth.uid()
    )
  );

create policy "affiliate_commission_history: merchant read"
  on public.affiliate_commission_history for select
  using (
    exists (
      select 1 from public.affiliate_commissions c
      where c.id = affiliate_commission_history.commission_id and c.merchant_id = auth.uid()
    )
  );

drop trigger if exists affiliate_commission_history_immutable on public.affiliate_commission_history;
create trigger affiliate_commission_history_immutable
  before update or delete on public.affiliate_commission_history
  for each row execute function public.prevent_row_mutation();
