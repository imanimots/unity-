-- ============================================================
-- E23 -- Contain escrow-refund / merchant-payout desynchronization
-- ============================================================
-- A fresh audit of the full post-dispute financial lifecycle (every
-- payout-creation path, both payout-safety gate functions, the escrow
-- refund path, and the generic payment-refund path, independently
-- traced from their current authoritative definitions) found two
-- distinct issues. This migration addresses only the one with a
-- safe, deterministic fix; the other is deliberately NOT addressed
-- here -- see this phase's final report for the full matrix.
--
-- NOT addressed in this migration (requires a product decision, not
-- a technical fix): none of the four dispute outcomes
-- (favor_respondent, favor_raiser, mutual_agreement, manual_settlement)
-- has a structured financial disposition anywhere in this schema --
-- `disputes.outcome` is a bare label, `resolution_notes` is free
-- text, and docs/DISPUTE_SYSTEM.md explicitly defers "outcome-driven
-- financial execution" as future, undesigned work. Since booking
-- status is now restored for ALL four outcomes
-- (20260904000003_dispute_resolve_restore_booking_all_outcomes.sql,
-- a deliberate, later product decision this migration does not
-- revisit), a booking resolved favor_raiser/mutual_agreement/
-- manual_settlement can currently become payout- and escrow-release-
-- eligible with zero technical distinction from favor_respondent,
-- UNLESS a human admin separately and manually runs create_refund()
-- or the escrow refund route for that booking -- neither of which
-- dispute resolution ever triggers automatically (confirmed: zero
-- references to either in resolve_dispute's current body or the
-- admin resolve route). Fabricating a rule here (e.g. "favor_raiser
-- always blocks payout") would be inventing business logic this
-- codebase has never defined, which this migration deliberately does
-- not do.
--
-- Addressed in this migration (a narrow, deterministic consistency
-- fix, not a new policy): the booking-branch payout-safety gates
-- already block payment-refund-after-payout scenarios by checking
-- `public.payments.status in ('refunded', 'partially_refunded',
-- 'chargeback')` -- proving the underlying policy ("do not advance a
-- payout once this transaction's money has demonstrably already gone
-- back to the customer") already exists and is already enforced for
-- ONE of the two systems that can record a refund for a booking. It
-- was never extended to the OTHER such system: `public.escrow_
-- transactions`. A fresh trace confirms the admin escrow-refund route
-- (POST /api/admin/escrow/[id]/refund -> refundEscrowTransaction() ->
-- public.refund_escrow_transaction()) updates ONLY escrow_transactions
-- and escrow_transaction_history -- it never touches public.payments,
-- public.refunds, public.ledger_entries, or public.merchant_payouts.
-- Today this means: an admin can refund a booking's held escrow
-- funds back to the customer, and the booking's merchant_payouts
-- eligibility is completely unaffected -- payout creation, the
-- pending-to-processing transition, and the processing-to-paid
-- transition all remain fully possible, since nothing anywhere
-- checks escrow_transactions.status. This is a confirmed, real
-- financial-consistency gap, not a hypothetical one (the escrow
-- refund route is live and reachable today, unlike create_refund,
-- which has zero production call sites).
--
-- Fix: extend the SAME existing booking-branch check in both
-- public._merchant_payout_full_eligibility_block (checked by
-- mark_payout_processing and retry_payout, before pending/failed ->
-- processing) and public._merchant_payout_still_safe_to_pay_block
-- (checked by mark_payout_paid, before processing -> paid) to also
-- treat a booking-linked escrow_transactions row with
-- status in ('refunded', 'partially_refunded') as the same
-- 'source_payment_issue' category the payments-status check already
-- returns. This closes the dangerous transitions (into 'processing'
-- and into 'paid', where money actually moves) with the smallest
-- possible change -- it does not touch payout creation itself
-- (createMerchantPayout / _payout_reconcile_missing_candidates), so a
-- payout row may still be created in 'pending' status for such a
-- booking, exactly mirroring how an already-refunded *payment*
-- already behaves today (a pending payout against a refunded payment
-- already exists as a real, un-blocked-at-creation state that
-- surfaces via the existing merchant_payout_source_payment_issue
-- admin exception category -- this migration does not change that
-- precedent, only applies it consistently to the second
-- refund-recording table).
--
-- Deliberately scoped to the BOOKING branch only, per this phase's
-- own title and primary question -- the rent_to_buy_agreement_id
-- branch of both functions is left untouched (reported separately as
-- an analogous, out-of-scope risk). mark_payout_failed is untouched
-- -- it must remain usable precisely when a financial problem exists,
-- per its own existing "no positive-eligibility gate" design.
-- _escrow_transaction_completion_block / _escrow_transaction_
-- dispute_block (the escrow-release-side gates) are also untouched --
-- the symmetric payment-refund-blocks-escrow-release direction has no
-- live caller today (create_refund has zero production call sites)
-- and is reported, not fixed, to keep this change to the smallest set
-- that closes an actual, confirmed bypass.
--
-- No ledger_entries row is touched (E18 remains binding -- this
-- migration contains no INSERT/UPDATE/DELETE against any table at
-- all, only two function redefinitions). No existing payout amount is
-- mutated. No RLS/grant/table/trigger/extension change. SECURITY
-- DEFINER, search_path = public (unchanged -- not E23's concern), and
-- the existing service_role-only execute boundary are all preserved;
-- CREATE OR REPLACE FUNCTION restates every existing clause exactly
-- as before except for the one inserted check in each body.
-- ============================================================

create or replace function public._merchant_payout_full_eligibility_block(p_payout public.merchant_payouts)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking record;
  v_rental_payment record;
  v_agreement record;
begin
  if p_payout.rent_to_buy_agreement_id is not null then
    select status::text as status, settled_at into v_agreement from public.rent_to_buy_agreements where id = p_payout.rent_to_buy_agreement_id;
    if v_agreement.status is null then
      return 'source_payment_issue';
    end if;
    if not (
      v_agreement.status = 'completed'
      or (v_agreement.status in ('defaulted', 'cancelled') and v_agreement.settled_at is not null)
    ) then
      return 'source_payment_issue';
    end if;
    if exists (select 1 from public.disputes where rent_to_buy_agreement_id = p_payout.rent_to_buy_agreement_id and status not in ('resolved', 'closed', 'cancelled')) then
      return 'compliance_review';
    end if;
    if exists (select 1 from public.profiles where id = p_payout.merchant_id and account_status in ('suspended', 'restricted')) then
      return 'account_restricted';
    end if;
    return null;
  end if;

  if p_payout.booking_id is null then
    return 'source_payment_issue';
  end if;

  select id, status, merchant_id into v_booking from public.bookings where id = p_payout.booking_id;
  if v_booking.id is null or v_booking.status <> 'completed' then
    return 'source_payment_issue';
  end if;

  select id, status into v_rental_payment
  from public.payments
  where booking_id = p_payout.booking_id and payment_type = 'rental_charge';
  if v_rental_payment.id is null or v_rental_payment.status <> 'captured' then
    return 'source_payment_issue';
  end if;

  -- E23: the SAME category this payment-status check already returns,
  -- extended to the escrow refund table -- an admin may have already
  -- returned this booking's held escrow principal to the customer
  -- through the separate escrow-refund path, which never touches
  -- public.payments.
  if exists (
    select 1 from public.escrow_transactions
    where booking_id = p_payout.booking_id and status in ('refunded', 'partially_refunded')
  ) then
    return 'source_payment_issue';
  end if;

  if exists (
    select 1 from public.disputes
    where booking_id = p_payout.booking_id and status not in ('resolved', 'closed', 'cancelled')
  ) then
    return 'compliance_review';
  end if;

  if exists (
    select 1 from public.profiles where id = p_payout.merchant_id and account_status in ('suspended', 'restricted')
  ) then
    return 'account_restricted';
  end if;

  return null;
end;
$$;
revoke all on function public._merchant_payout_full_eligibility_block(public.merchant_payouts) from public, anon, authenticated;
grant execute on function public._merchant_payout_full_eligibility_block(public.merchant_payouts) to service_role;

create or replace function public._merchant_payout_still_safe_to_pay_block(p_payout public.merchant_payouts)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rental_payment_status payment_status;
begin
  if p_payout.rent_to_buy_agreement_id is not null then
    if exists (select 1 from public.disputes where rent_to_buy_agreement_id = p_payout.rent_to_buy_agreement_id and status not in ('resolved', 'closed', 'cancelled')) then
      return 'compliance_review';
    end if;
    if exists (select 1 from public.profiles where id = p_payout.merchant_id and account_status in ('suspended', 'restricted')) then
      return 'account_restricted';
    end if;
    return null;
  end if;

  if exists (
    select 1 from public.disputes
    where booking_id = p_payout.booking_id and status not in ('resolved', 'closed', 'cancelled')
  ) then
    return 'compliance_review';
  end if;

  if exists (
    select 1 from public.profiles where id = p_payout.merchant_id and account_status in ('suspended', 'restricted')
  ) then
    return 'account_restricted';
  end if;

  select status into v_rental_payment_status
  from public.payments
  where booking_id = p_payout.booking_id and payment_type = 'rental_charge';
  if v_rental_payment_status in ('refunded', 'partially_refunded', 'chargeback') then
    return 'source_payment_issue';
  end if;

  -- E23: same extension as the full-eligibility block above -- an
  -- escrow refund recorded after a payout already reached
  -- 'processing' must still stop it from being marked 'paid'.
  if exists (
    select 1 from public.escrow_transactions
    where booking_id = p_payout.booking_id and status in ('refunded', 'partially_refunded')
  ) then
    return 'source_payment_issue';
  end if;

  return null;
end;
$$;
revoke all on function public._merchant_payout_still_safe_to_pay_block(public.merchant_payouts) from public, anon, authenticated;
grant execute on function public._merchant_payout_still_safe_to_pay_block(public.merchant_payouts) to service_role;
