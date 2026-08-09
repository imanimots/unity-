-- ============================================================
-- Phase 3 -- Escrow architecture / TradeSafe readiness
-- Core schema: escrow_status enum + escrow_transactions.
-- ============================================================
-- Additive only -- no existing table is altered. escrow_transactions is
-- a custody WRAPPER around an existing payments row, never a
-- replacement for it: payment_id is a nullable FK into payments (set
-- once the underlying payment intent exists) and is unique, so at most
-- one escrow transaction can ever wrap a given payment.
--
-- transaction_type/order_id/booking_id/barter_agreement_id mirrors the
-- exact 3-way exactly-one-of shape already proven on payments/messages/
-- disputes (see 20260816000002_barter_payments_widening.sql).
--
-- principal_amount is the amount held in trust (item price / rental fee
-- / barter cash difference) -- it is NEVER Unity commission and never
-- summed with it. secure_transaction_fee_amount is a separate,
-- independent figure (what an escrow provider charges to hold funds),
-- also never summed into principal_amount or into Unity commission.
-- Every amount is server-derived by the orchestrator layer
-- (src/lib/escrow/orchestrator/) -- never a client-supplied parameter.
--
-- escrow_status: pending (created, not yet funded) -> funded (holding
-- real captured funds in trust) -> released (paid out to released_to)
-- or refunded/partially_refunded (returned to the payer) or cancelled
-- (voided while still pending, never funded) or failed (a provider-side
-- funding/release/refund attempt did not succeed). There is no separate
-- "disputed" or "held" status here -- escrow release checks the SAME
-- dispute signal booking/order/barter already expose
-- (status = 'disputed' / an unresolved disputes row) rather than
-- inventing a second, competing freeze state (see
-- _escrow_transaction_dispute_block in the RPCs migration).
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

do $$
begin
  if not exists (select 1 from pg_type where typname = 'escrow_status') then
    create type escrow_status as enum ('pending', 'funded', 'released', 'refunded', 'partially_refunded', 'cancelled', 'failed');
  end if;
end$$;

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

create index if not exists escrow_transactions_booking_idx on public.escrow_transactions(booking_id);
create index if not exists escrow_transactions_order_idx on public.escrow_transactions(order_id);
create index if not exists escrow_transactions_barter_agreement_idx on public.escrow_transactions(barter_agreement_id);
create index if not exists escrow_transactions_status_idx on public.escrow_transactions(status);

create or replace function public.touch_escrow_transaction_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists escrow_transactions_touch_updated_at on public.escrow_transactions;
create trigger escrow_transactions_touch_updated_at
  before update on public.escrow_transactions
  for each row execute procedure public.touch_escrow_transaction_updated_at();

alter table public.escrow_transactions enable row level security;

-- Zero client write policies -- every mutation goes through a
-- SECURITY DEFINER, service-role-only RPC (see the RPCs migration),
-- matching barter_agreements/disputes/affiliate_commissions' fully
-- RPC-gated model exactly.
create policy "escrow_transactions: parties read"
  on public.escrow_transactions for select
  using (
    exists (
      select 1 from public.bookings
      where bookings.id = escrow_transactions.booking_id
        and (bookings.renter_id = auth.uid() or bookings.merchant_id = auth.uid())
    )
    or exists (
      select 1 from public.orders
      where orders.id = escrow_transactions.order_id
        and (orders.buyer_id = auth.uid() or orders.seller_id = auth.uid())
    )
    or exists (
      select 1 from public.barter_agreements
      where barter_agreements.id = escrow_transactions.barter_agreement_id
        and (barter_agreements.party_a_id = auth.uid() or barter_agreements.party_b_id = auth.uid())
    )
  );
