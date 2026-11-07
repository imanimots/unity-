-- ============================================================
-- E22 -- Restore a regressed dispute fix-forward for escrow release
-- ============================================================
-- A fresh audit (triggered by a risk flagged at the end of the prior
-- phase) confirms public._escrow_transaction_dispute_block's current
-- live body has regressed a deliberate, already-shipped correction.
--
-- Timeline, independently re-verified from migration history, not
-- assumed:
--   1. 20260825000003_escrow_rpcs.sql -- original dispute-block
--      helper: for booking/order/barter, checks BOTH the
--      transaction's own status = 'disputed' AND an unresolved
--      public.disputes row.
--   2. 20260825000007_escrow_dispute_block_order_barter_fix.sql --
--      deliberate fix-forward, explained in its own header: resolving
--      a dispute never restores orders.status or
--      barter_agreements.status back off 'disputed' (only bookings
--      has that restoration mechanism), so checking those two
--      columns here means an order/barter agreement that was EVER
--      disputed can never have its escrow released again, even after
--      a genuine, favorable resolution -- confirmed live-tested and
--      failing. Fix: for order/barter only, drop the own-status
--      check and rely solely on the disputes table's own status,
--      which does update correctly on resolution. The booking branch
--      is explicitly left unchanged in that same migration -- booking
--      restoration IS outcome-sensitive (see 20260904000003), so
--      checking bookings.status = 'disputed' there remains correct
--      and meaningful.
--   3. 20260821183600_rtb_v2_rpcs.sql (RTB v2 widening) -- added the
--      rent_to_buy_agreement_id branch to this same function via its
--      own CREATE OR REPLACE. Confirmed (E21's own audit) to actually
--      deploy AFTER 20260825000007 despite its earlier-looking
--      filename timestamp (its own header comment for a sibling
--      function explicitly drops-then-recreates an older signature
--      "to avoid a live ambiguous duplicate overload," proving intent
--      to run after the Aug 25 batch). Its booking/order/barter
--      branches are reproduced from a copy of the function that
--      PREDATES 007's fix -- re-adding the exact
--      `orders.status = 'disputed'` and
--      `barter_agreements.status = 'disputed'` checks 007 removed,
--      while correctly adding a DUAL-signal RTB branch (RTB *does*
--      restore its own status on favor_respondent resolution, so
--      checking rent_to_buy_agreements.status = 'disputed' there is
--      correct, same reasoning as booking).
--
-- This migration merges 007's corrected order/barter semantics with
-- the RTB branch, rather than reverting the RTB work: booking and RTB
-- keep their dual-signal (own-status OR active-dispute) check; order
-- and barter keep only the active-dispute check. The "active dispute"
-- definition (status not in ('resolved', 'closed', 'cancelled')) is
-- unchanged. public._escrow_transaction_completion_block (the
-- independent entitlement gate release_escrow_transaction also calls)
-- is NOT touched by this migration -- removing the stale order/barter
-- own-status check here does not create unconditional release
-- eligibility, since that second gate still independently requires
-- genuine transaction completion (or a favorable dispute outcome
-- whose captured pre_dispute_status was already terminal).
--
-- A second target named in this phase's own brief,
-- public.resolve_dispute's booking-restoration condition, was
-- investigated and found NOT to be a regression: a later, explicit,
-- dated product decision
-- (20260904000003_dispute_resolve_restore_booking_all_outcomes.sql,
-- 2026-09-04 -- chronologically after both the 2026-08-24
-- favor_respondent-only fix and the 2026-08-28 RTB-restore migration,
-- with no ordering ambiguity) deliberately removed the
-- `p_outcome = 'favor_respondent'` restriction from booking
-- restoration specifically, while explicitly preserving it for RTB
-- ("a separate, already-closed decision... must not change here" --
-- that file's own words). Reverting this would reintroduce the exact
-- behavior that later decision chose to leave behind. This migration
-- therefore does not touch public.resolve_dispute at all.
--
-- SECURITY DEFINER, search_path = '' (E21), and the service_role-only
-- execute boundary are all preserved unchanged. CREATE OR REPLACE
-- FUNCTION resets any omitted SET clause, so search_path = '' is
-- re-stated explicitly here rather than relied upon implicitly.
-- ============================================================

create or replace function public._escrow_transaction_dispute_block(p_escrow public.escrow_transactions)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_escrow.booking_id is not null then
    -- Booking restoration is outcome-sensitive (resolve_dispute only
    -- restores bookings.status off 'disputed' -- never for order/
    -- barter), so a deliberately-left-disputed booking must continue
    -- blocking release. Dual signal retained.
    if exists (select 1 from public.bookings where id = p_escrow.booking_id and status = 'disputed') then
      return 'unresolved_dispute';
    end if;
    if exists (select 1 from public.disputes where booking_id = p_escrow.booking_id and status not in ('resolved', 'closed', 'cancelled')) then
      return 'unresolved_dispute';
    end if;
  elsif p_escrow.order_id is not null then
    -- orders.status is never restored after dispute resolution (no
    -- equivalent to bookings' restoration mechanism exists for
    -- orders) -- the disputes table's own status is the only reliable
    -- signal here (fix-forward from 20260825000007, re-applied).
    if exists (select 1 from public.disputes where order_id = p_escrow.order_id and status not in ('resolved', 'closed', 'cancelled')) then
      return 'unresolved_dispute';
    end if;
  elsif p_escrow.barter_agreement_id is not null then
    -- Same reasoning as orders -- barter_agreements.status is never
    -- restored after dispute resolution either.
    if exists (select 1 from public.disputes where barter_agreement_id = p_escrow.barter_agreement_id and status not in ('resolved', 'closed', 'cancelled')) then
      return 'unresolved_dispute';
    end if;
  elsif p_escrow.rent_to_buy_agreement_id is not null then
    -- Dual-signal, same as booking -- RTB dispute resolution DOES
    -- restore the agreement's own status on favor_respondent
    -- resolution, unlike order/barter which never restore theirs.
    if exists (select 1 from public.rent_to_buy_agreements where id = p_escrow.rent_to_buy_agreement_id and status = 'disputed') then
      return 'unresolved_dispute';
    end if;
    if exists (select 1 from public.disputes where rent_to_buy_agreement_id = p_escrow.rent_to_buy_agreement_id and status not in ('resolved', 'closed', 'cancelled')) then
      return 'unresolved_dispute';
    end if;
  end if;
  return null;
end;
$$;
