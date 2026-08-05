-- ============================================================
-- Buying & selling checkout — payment_type enum value
-- ============================================================
-- Isolated in its own migration -- Postgres requires a newly ADDed enum
-- value to commit before it can be USEd, so this cannot share a
-- transaction with anything that references 'order_payment' (this
-- codebase has hit that restriction before, e.g. 20260810000002 for
-- barter's two new payment_type values).
--
-- One value, not two -- unlike barter (deposit + cash adjustment), a
-- purchase order has exactly one charge, no separate deposit line item
-- (buy/sell has no deposit concept at all).
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

alter type payment_type add value if not exists 'order_payment';
