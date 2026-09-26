-- ============================================================
-- Unity -- RTB Deposit: Legacy deposit_funded_at Backfill (P5D-M4.1)
-- ============================================================
-- Before P5D-M4, the active record_rent_to_buy_deposit_payment
-- (20260827000005_rtb_rpcs.sql) could write a 'deposit_paid'
-- rent_to_buy_history event without ever setting
-- rent_to_buy_agreements.deposit_funded_at. P5D-M4 fixes every FUTURE
-- and REPLAYED call, but P5D-M4-R found no currently-reachable
-- automatic path re-invokes this RPC for an already-captured deposit
-- (charge-rent-to-buy-deposit.ts's own "already captured -> return
-- early" guard prevents it, and async webhook progression never wires
-- RTB deposit at all) -- so any agreement whose deposit was captured
-- before P5D-M4 exists would otherwise carry this broken state forever,
-- silently skipping its deposit refund/forfeit branch in
-- finalize_rent_to_buy_ownership / _rent_to_buy_settle_default_
-- before_possession / _rent_to_buy_settle_default_after_possession
-- whenever settlement eventually runs.
--
-- This migration repairs ONLY historical rows with complete,
-- unambiguous, already-persisted proof -- never a guess:
--   - the agreement's deposit_funded_at is currently NULL;
--   - exactly one payments row is its canonical rent_to_buy_deposit
--     payment (payments_rtb_deposit_unique, 20260827000004_rtb_
--     widening.sql, already guarantees at most one such row per
--     agreement), captured, with amount exactly equal to
--     security_deposit_amount;
--   - every 'deposit_paid' rent_to_buy_history row for that agreement
--     (there is no other writer of this event_type anywhere in this
--     codebase, confirmed fresh) has a non-null metadata.payment_id,
--     and every one of them names that exact same canonical payment --
--     never a row naming a different payment, never a malformed/
--     missing payment_id.
-- An agreement with ANY ambiguity (a missing/malformed payment_id row,
-- a row naming a different payment, more than one distinct payment
-- identity in its history, no canonical payment at all, or no matching
-- history at all) is left completely untouched -- deposit_funded_at
-- stays NULL, for manual review. A safe false-negative is preferred
-- over an unsafe inferred repair.
--
-- The restored timestamp is MIN(created_at) over the agreement's
-- matching history rows -- the same source P5D-M4's own legacy-healing
-- branch uses, for consistency -- never now() or any other proxy.
--
-- Read-only with respect to payments and rent_to_buy_history (the
-- latter is enforced immutable by its own rtb_history_immutable
-- trigger regardless); the only mutation is deposit_funded_at itself.
-- Logically idempotent: the final UPDATE's own `deposit_funded_at is
-- null` guard means re-running this migration's logic against an
-- already-healed agreement changes nothing.
--
-- Does not modify record_rent_to_buy_deposit_payment (P5D-M4, reviewed
-- and passed) or any other RPC. No new table/column/index/constraint.
--
-- Source-only this phase -- NOT applied to any database. This does not
-- claim any specific number of affected rows exist -- it safely repairs
-- whatever qualifying rows are present, if any, at the time it is
-- applied.
-- ============================================================

with canonical_payment as (
  -- deposit_funded_at is null is checked here too, independently of the
  -- final UPDATE's own guard below -- defense in depth, never relying
  -- on a single layer to protect an already-correct value.
  select p.id as payment_id, p.rent_to_buy_agreement_id as agreement_id
  from public.payments p
  join public.rent_to_buy_agreements a on a.id = p.rent_to_buy_agreement_id
  where p.rent_to_buy_agreement_id is not null
    and p.payment_type = 'rent_to_buy_deposit'
    and p.status = 'captured'
    and p.amount is not distinct from a.security_deposit_amount
    and a.deposit_funded_at is null
),
history_evidence as (
  select
    h.agreement_id,
    count(*) filter (where h.metadata ->> 'payment_id' is null) as malformed_count,
    count(distinct h.metadata ->> 'payment_id') as distinct_payment_id_count,
    min(h.created_at) as earliest_created_at,
    min(h.metadata ->> 'payment_id') as sample_payment_id
  from public.rent_to_buy_history h
  where h.event_type = 'deposit_paid'
  group by h.agreement_id
),
safe_candidates as (
  select cp.agreement_id, he.earliest_created_at
  from canonical_payment cp
  join history_evidence he on he.agreement_id = cp.agreement_id
  where he.malformed_count = 0
    and he.distinct_payment_id_count = 1
    and he.sample_payment_id = cp.payment_id::text
)
update public.rent_to_buy_agreements a
set deposit_funded_at = sc.earliest_created_at
from safe_candidates sc
where a.id = sc.agreement_id
  and a.deposit_funded_at is null;
