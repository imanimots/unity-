-- ============================================================
-- Step 11 Phase 7 -- affiliate_commission_status enum
-- ============================================================
-- Isolated in its own migration (never used in the same transaction it
-- is created, per this project's own established rule for enums).
-- Deliberately a NEW enum, not a widening of the existing payout_status
-- (pending/processing/paid/failed) -- a commission's lifecycle includes
-- pre-payout review states (pending/held/approved) that payout_status
-- was never designed to express, and payout_status is scoped to
-- merchant_payouts, a different, unrelated domain.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

do $$ begin
  create type public.affiliate_commission_status as enum (
    'pending',
    'held',
    'approved',
    'payout_queued',
    'processing',
    'paid',
    'failed',
    'voided',
    'reversed'
  );
exception when duplicate_object then null; end $$;
