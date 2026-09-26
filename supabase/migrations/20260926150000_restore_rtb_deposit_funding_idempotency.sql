-- ============================================================
-- Unity -- RTB Deposit: Idempotent Funding + deposit_funded_at Restore (P5D-M4)
-- ============================================================
-- P5D-M4-D found that the currently-ACTIVE record_rent_to_buy_deposit_
-- payment (20260827000005_rtb_rpcs.sql, later than the "v2" definition
-- in 20260821183600_rtb_v2_rpcs.sql and therefore the one that actually
-- won) regressed three things the earlier version had:
--   1. it never validates p_payment_id against public.payments at all --
--      any UUID is accepted and stored, opaque, in history metadata;
--   2. it never sets rent_to_buy_agreements.deposit_funded_at, which
--      finalize_rent_to_buy_ownership / _rent_to_buy_settle_default_
--      before_possession / _rent_to_buy_settle_default_after_possession
--      (all three still active, never redefined since Aug 21) still read
--      as their deposit-refund/forfeit gate -- meaning that gate has
--      been dead code for every RTB agreement processed by the active
--      system;
--   3. it has no idempotency guard at all -- every call unconditionally
--      inserts a new 'deposit_paid' rent_to_buy_history row, so it
--      cannot safely be re-invoked (e.g. from async webhook
--      already_current recovery, P5D-B.2's own reason for NOT wiring
--      it).
--
-- This migration corrects the function body only -- same exact
-- signature, no DROP, no new table/column/index/constraint.
-- payments_rtb_deposit_unique (20260827000004_rtb_widening.sql, a
-- partial unique index on payments(rent_to_buy_agreement_id) where
-- payment_type = 'rent_to_buy_deposit') already guarantees at most one
-- such payment row can ever exist per agreement -- the durable
-- canonical payment identity this fix relies on, confirmed unchanged
-- since it was created.
--
-- Deliberately NOT restored: the historical call to
-- _rent_to_buy_check_possession_eligibility(). That helper implements a
-- possession-eligibility model that has been superseded -- the active
-- record_rent_to_buy_installment_payment (20260827000005_rtb_rpcs.sql)
-- now triggers possession_eligible purely on "installment sequence 1
-- paid while status = 'awaiting_first_payment'", with no reference to
-- deposit funding at all. Re-calling the orphaned helper here would
-- apply a model the rest of the active RPC set no longer holds.
--
-- LEGACY BROKEN-STATE HEALING: the currently-active (broken) function
-- has been writing 'deposit_paid' rent_to_buy_history rows (metadata =
-- {"payment_id": p_payment_id}) without ever setting deposit_funded_at,
-- since it was first applied. 'deposit_paid' is written nowhere else in
-- this codebase (confirmed by exhaustive search), always with this
-- exact metadata shape, by this same SECURITY DEFINER function only --
-- so a history row matching (this agreement, this ALREADY-VALIDATED
-- canonical payment) is trustworthy evidence that this exact deposit
-- was already recorded under the old behavior. On detecting one, this
-- version restores deposit_funded_at from that row's own created_at
-- (the earliest such row, if more than one exists) -- never now(), which
-- would falsely claim the deposit was funded at migration/healing time
-- instead of when it actually was -- and returns the same idempotent
-- success shape as an ordinary same-payment replay, inserting no
-- further history.
--
-- Source-only this phase -- NOT applied to any database.
-- ============================================================

create or replace function public.record_rent_to_buy_deposit_payment(
  p_agreement_id uuid, p_payment_id uuid, p_idempotency_key text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_agreement record;
  v_payment record;
  v_legacy_funded_at timestamptz;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;

  select * into v_agreement from public.rent_to_buy_agreements where id = p_agreement_id for update;
  if v_agreement.id is null then raise exception 'agreement not found'; end if;
  if v_agreement.security_deposit_amount is null then raise exception 'this agreement has no security deposit configured'; end if;

  -- Payment validated BEFORE any idempotency-driven return -- an
  -- unrelated or invalid p_payment_id must never receive a false
  -- already_paid success merely because deposit_funded_at happens to
  -- already be set for this agreement.
  select id, rent_to_buy_agreement_id, payment_type, status, amount into v_payment
  from public.payments where id = p_payment_id;
  if v_payment.id is null then raise exception 'payment not found'; end if;
  if v_payment.rent_to_buy_agreement_id is distinct from p_agreement_id then raise exception 'payment does not belong to this agreement'; end if;
  if v_payment.payment_type <> 'rent_to_buy_deposit' then raise exception 'payment is not a rent-to-buy deposit payment'; end if;
  if v_payment.status <> 'captured' then raise exception 'payment has not been captured'; end if;
  if v_payment.amount is distinct from v_agreement.security_deposit_amount then raise exception 'payment amount does not match the agreement''s configured security deposit amount'; end if;

  if v_agreement.deposit_funded_at is not null then
    -- Already completed via this same canonical payment --
    -- payments_rtb_deposit_unique guarantees p_payment_id, once
    -- validated above, IS the one deposit payment this agreement can
    -- ever have. A safe, natural same-payment replay: no new history
    -- row, no rewritten timestamp, no other mutation.
    return jsonb_build_object('agreement_id', p_agreement_id, 'deposit_paid', true, 'already_paid', true);
  end if;

  -- Legacy-healing: detect a 'deposit_paid' history row the broken
  -- (pre-P5D-M4) function already wrote for this exact agreement and
  -- this exact, already-validated canonical payment. min(created_at)
  -- picks the earliest such row if the broken function was somehow
  -- called more than once for the same payment.
  select min(created_at) into v_legacy_funded_at
  from public.rent_to_buy_history
  where agreement_id = p_agreement_id
    and event_type = 'deposit_paid'
    and metadata ->> 'payment_id' = p_payment_id::text;

  if v_legacy_funded_at is not null then
    update public.rent_to_buy_agreements set deposit_funded_at = v_legacy_funded_at where id = p_agreement_id;
    return jsonb_build_object('agreement_id', p_agreement_id, 'deposit_paid', true, 'already_paid', true);
  end if;

  -- First clean completion.
  update public.rent_to_buy_agreements set deposit_funded_at = now() where id = p_agreement_id;
  perform public._rent_to_buy_history(p_agreement_id, 'system', null, 'deposit_paid', null, null, jsonb_build_object('payment_id', p_payment_id));

  return jsonb_build_object('agreement_id', p_agreement_id, 'deposit_paid', true, 'already_paid', false);
end;
$$;

revoke all on function public.record_rent_to_buy_deposit_payment(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.record_rent_to_buy_deposit_payment(uuid, uuid, text) to service_role;
