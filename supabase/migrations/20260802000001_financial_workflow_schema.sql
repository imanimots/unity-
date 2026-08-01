-- ============================================================
-- Financial workflow schema (Financial Orchestrator hardening pass)
-- ============================================================
-- Of the orchestrator's five workflows (prepare, authorize, release
-- deposit, capture deposit, create payout), only "authorize booking
-- financials" is genuinely multi-step from a resumability standpoint --
-- it makes two separate provider calls (rental charge, then deposit
-- authorization) and must be able to resume at whichever one failed
-- without repeating the one that already succeeded. The other four are
-- single provider-call operations already safely idempotent via the
-- existing idempotency_keys table (prepare's own payment rows are also
-- naturally deduplicated by payments_booking_type_unique). Adding a
-- workflow table for those four would track state the payments table
-- and idempotency_keys already carry -- deliberately not done.
--
-- workflow_status is intentionally never merged with payment_status or
-- booking_status -- it tracks the orchestrator's own multi-step
-- progress, a different concern from either domain's own state.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

do $$ begin
  create type workflow_status as enum ('pending', 'processing', 'completed', 'failed_retryable', 'failed_terminal');
exception when duplicate_object then null; end $$;

create table if not exists public.financial_workflows (
  id uuid primary key default uuid_generate_v4(),
  booking_id uuid not null references public.bookings(id),
  workflow_type text not null,
  status workflow_status not null default 'pending',
  provider text not null,
  current_step text,
  last_error_code text,
  last_error_message text,
  retry_count int not null default 0,
  idempotency_key text,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint financial_workflows_unique unique (booking_id, workflow_type)
);

create index if not exists financial_workflows_status_idx on public.financial_workflows(status);

create or replace function public.touch_financial_workflow_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists financial_workflows_touch_updated_at on public.financial_workflows;
create trigger financial_workflows_touch_updated_at
  before update on public.financial_workflows
  for each row execute procedure public.touch_financial_workflow_updated_at();

alter table public.financial_workflows enable row level security;
create policy "financial_workflows: booking parties read"
  on public.financial_workflows for select
  using (
    exists (
      select 1 from public.bookings b
      where b.id = financial_workflows.booking_id
        and (b.renter_id = auth.uid() or b.merchant_id = auth.uid())
    )
  );
-- No write policy for anon/authenticated -- service-role RPCs only
-- (20260802000002_financial_workflow_rpcs.sql).
