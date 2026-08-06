-- ============================================================
-- Step 11 Phase 7 -- affiliate_commission_adjustments (append-only)
-- ============================================================
-- The ONLY way to correct a paid/finalized commission's effective
-- amount without ever rewriting the original row (Decision 11): admins
-- cannot edit commission_amount/rate/affiliate/customer/merchant/
-- listing/payment_id anywhere. A correction is either void + regenerate
-- (a whole new commission row via the normal qualification path) or an
-- append-only signed adjustment referencing the original.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

create table if not exists public.affiliate_commission_adjustments (
  id              uuid primary key default uuid_generate_v4(),
  commission_id   uuid not null references public.affiliate_commissions(id),
  amount          numeric(12,2) not null,
  reason          text not null,
  created_by      uuid not null references public.profiles(id),
  idempotency_key text,
  created_at      timestamptz not null default now()
);

create index if not exists affiliate_commission_adjustments_commission_idx on public.affiliate_commission_adjustments(commission_id);

alter table public.affiliate_commission_adjustments enable row level security;

create policy "affiliate_commission_adjustments: affiliate read"
  on public.affiliate_commission_adjustments for select
  using (
    exists (
      select 1 from public.affiliate_commissions c
      where c.id = affiliate_commission_adjustments.commission_id and c.affiliate_id = auth.uid()
    )
  );

create policy "affiliate_commission_adjustments: merchant read"
  on public.affiliate_commission_adjustments for select
  using (
    exists (
      select 1 from public.affiliate_commissions c
      where c.id = affiliate_commission_adjustments.commission_id and c.merchant_id = auth.uid()
    )
  );

drop trigger if exists affiliate_commission_adjustments_immutable on public.affiliate_commission_adjustments;
create trigger affiliate_commission_adjustments_immutable
  before update or delete on public.affiliate_commission_adjustments
  for each row execute function public.prevent_row_mutation();
