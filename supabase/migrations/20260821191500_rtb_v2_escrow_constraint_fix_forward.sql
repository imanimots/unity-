-- ============================================================
-- Rent-to-Buy V2 -- fix-forward correction #2, found via live isolated
-- ESCROW_ENABLED=true verification.
-- ============================================================
-- 20260821183555_rtb_v2_schema.sql widened escrow_transactions with a
-- new rent_to_buy_agreement_id column and widened transaction_type_check
-- to allow 'rent_to_buy', but never widened the actual exactly-one-of
-- guard (escrow_transactions_one_transaction_chk) from its original
-- 3-way (booking/order/barter) shape to a 4-way shape including the new
-- column. Confirmed live: every RTB installment payment's
-- createEscrowForPayment() call failed with "new row for relation
-- escrow_transactions violates check constraint
-- escrow_transactions_one_transaction_chk" (caught by the orchestrator's
-- own best-effort try/catch, so payments still succeeded, but zero RTB
-- escrow rows were ever created even with ESCROW_ENABLED=true -- a
-- fail-open-looking-like-fail-closed gap, not the intended fail-closed
-- behavior only when the flag is off).
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

alter table public.escrow_transactions drop constraint if exists escrow_transactions_one_transaction_chk;
alter table public.escrow_transactions add constraint escrow_transactions_one_transaction_chk check (
  (booking_id is not null and order_id is null and barter_agreement_id is null and rent_to_buy_agreement_id is null)
  or (booking_id is null and order_id is not null and barter_agreement_id is null and rent_to_buy_agreement_id is null)
  or (booking_id is null and order_id is null and barter_agreement_id is not null and rent_to_buy_agreement_id is null)
  or (booking_id is null and order_id is null and barter_agreement_id is null and rent_to_buy_agreement_id is not null)
);
