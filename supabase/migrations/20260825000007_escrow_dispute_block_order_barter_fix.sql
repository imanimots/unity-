-- ============================================================
-- Phase 3 -- fix-forward correction, found via live regression testing
-- (scripts/verify-escrow-phase3.mjs Scenario D).
-- ============================================================
-- _escrow_transaction_dispute_block() checked BOTH the underlying
-- transaction's own status = 'disputed' AND an unresolved disputes row.
-- For bookings that is correct and mirrors the exact, deliberate,
-- outcome-aware precedent from 20260824000002 (resolve_dispute()
-- restores bookings.status only for outcome = 'favor_respondent' --
-- staying 'disputed' for other outcomes is itself intentional).
--
-- But confirmed live (grep of 20260824000001/20260824000002): NEITHER
-- resolve_dispute() NOR cancel_dispute() ever restores orders.status or
-- barter_agreements.status -- only bookings.status is restored anywhere
-- in this codebase. That is a real, pre-existing, out-of-scope-for-
-- Phase-3 gap in the dispute system itself (fixing it would mean
-- redesigning dispute resolution for orders/barter, which Phase 3's own
-- brief explicitly forbids).
--
-- Given that gap, checking orders.status/barter_agreements.status here
-- would mean an order or barter agreement that was EVER disputed can
-- NEVER have its escrow released again, even after a legitimate
-- resolution -- confirmed live: Scenario D2 failed with
-- "not currently eligible to release: unresolved_dispute" even after
-- the dispute reached 'resolved'. That is overly strict in a way this
-- phase can fix without touching the dispute RPCs at all: for orders
-- and barter agreements, the disputes table's own status is the only
-- reliable signal (it DOES update correctly on resolution), so the
-- transaction-status check is dropped for those two branches only. The
-- booking branch is UNCHANGED -- still checks both signals, matching
-- the existing, deliberate, outcome-aware precedent exactly.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

create or replace function public._escrow_transaction_dispute_block(p_escrow public.escrow_transactions)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_escrow.booking_id is not null then
    if exists (select 1 from public.bookings where id = p_escrow.booking_id and status = 'disputed') then
      return 'unresolved_dispute';
    end if;
    if exists (select 1 from public.disputes where booking_id = p_escrow.booking_id and status not in ('resolved', 'closed', 'cancelled')) then
      return 'unresolved_dispute';
    end if;
  elsif p_escrow.order_id is not null then
    -- orders.status is never restored after dispute resolution (no
    -- equivalent to bookings' pre_dispute_status mechanism exists for
    -- orders) -- the disputes table's own status is the only reliable
    -- signal here.
    if exists (select 1 from public.disputes where order_id = p_escrow.order_id and status not in ('resolved', 'closed', 'cancelled')) then
      return 'unresolved_dispute';
    end if;
  elsif p_escrow.barter_agreement_id is not null then
    -- Same reasoning as orders -- barter_agreements.status is never
    -- restored after dispute resolution either.
    if exists (select 1 from public.disputes where barter_agreement_id = p_escrow.barter_agreement_id and status not in ('resolved', 'closed', 'cancelled')) then
      return 'unresolved_dispute';
    end if;
  end if;
  return null;
end;
$$;
