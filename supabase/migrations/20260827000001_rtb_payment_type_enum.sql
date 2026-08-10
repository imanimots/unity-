-- ============================================================
-- Phase 5 -- Rent-to-Buy: payment_type enum widening.
-- ============================================================
-- Isolated migration -- ALTER TYPE ... ADD VALUE cannot be used in the
-- same transaction it's added, per this project's own established rule
-- (see 20260812000001_order_payment_type.sql / 20260816000001).
-- rent_to_buy_installment: one recurring scheduled purchase payment.
-- rent_to_buy_deposit: the separate, non-purchase-progress security
-- deposit (Rule 14 -- never counts toward the RTB purchase price).
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

alter type payment_type add value if not exists 'rent_to_buy_installment';
alter type payment_type add value if not exists 'rent_to_buy_deposit';
