-- ============================================================
-- Step 11 Phase 4 -- payment_type widening for barter
-- ============================================================
-- Adds the two payment_type values Barter Phase B needs. Isolated in
-- its own migration -- a value added via ALTER TYPE ... ADD VALUE
-- cannot be used in the same transaction it was added in, the same
-- rule already followed for dispute_status/barter_status/order_payment
-- widenings earlier in this project.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

alter type payment_type add value if not exists 'barter_deposit';
alter type payment_type add value if not exists 'barter_cash_adjustment';
