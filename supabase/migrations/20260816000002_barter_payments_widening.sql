-- ============================================================
-- Step 11 Phase 4 -- payments widening for barter
-- ============================================================
-- payments.barter_agreement_id was deliberately deferred from Step 11
-- Phase 1 to this exact point (see docs/STEP_11_FOUNDATIONS.md and
-- 20260812000002_order_payments_widening.sql's own header comment,
-- which explicitly anticipated this migration). Mirrors the order
-- widening pattern exactly: nullable FK column, CHECK becomes a 3-way
-- exactly-one-of.
--
-- payments_barter_type_payer_unique is NOT the plain
-- (barter_agreement_id, payment_type) shape orders got --  a two-sided
-- deposit genuinely needs two 'barter_deposit' rows for the same
-- agreement (one per payer), so the payer (renter_id, repurposed as a
-- generic payer-id column exactly as orders already repurposed it for
-- buyer_id) is part of the uniqueness key.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

alter table public.payments add column if not exists barter_agreement_id uuid references public.barter_agreements(id);

alter table public.payments drop constraint if exists payments_one_transaction_chk;

alter table public.payments add constraint payments_one_transaction_chk check (
  (booking_id is not null and order_id is null and barter_agreement_id is null)
  or (booking_id is null and order_id is not null and barter_agreement_id is null)
  or (booking_id is null and order_id is null and barter_agreement_id is not null)
);

alter table public.payments add constraint payments_barter_type_payer_unique unique (barter_agreement_id, payment_type, renter_id);

create index if not exists payments_barter_agreement_idx on public.payments(barter_agreement_id);
