-- ============================================================
-- Unity Phase 2 -- Commission Framework
-- unity_commission_status enum. Isolated in its own migration (never
-- used in the same transaction it is created, per this project's own
-- established rule for enums -- see 20260819000002).
--
-- Unlike affiliate_commission_status, there is no payout sub-lifecycle
-- here (payout_queued/processing/paid) -- Unity does not "pay itself";
-- its commission is realized simply by NOT including that amount in
-- the merchant's payout. The lifecycle only needs to track whether a
-- qualified commission is still provisional, frozen by a dispute,
-- finalized, reduced, or voided.
--   pending  -- qualified, provisional (a refund/dispute could still land)
--   held     -- an unresolved dispute exists on the underlying transaction
--   earned   -- finalized after the review window with no reduction
--   adjusted -- partially reduced by an approved partial refund (the
--               original commission_amount snapshot is never rewritten;
--               unity_commission_adjustments records the signed delta)
--   voided   -- fully refunded/cancelled -- zero commission retained
-- ============================================================

do $$ begin
  create type public.unity_commission_status as enum (
    'pending',
    'held',
    'earned',
    'adjusted',
    'voided'
  );
exception when duplicate_object then null; end $$;
