-- ============================================================
-- E26 -- Restore RTB's optional-escrow compatibility
-- ============================================================
-- A fresh, read-only live inspection confirmed a severe regression in
-- the prior phase's own RTB escrow-conservation work: every RTB
-- merchant payout for an agreement that never participated in escrow
-- (ESCROW_ENABLED unset/false at the time -- the documented default,
-- and the apparent live default) was blocked from ever advancing past
-- 'pending', and -- independently, and more severely -- any NEW
-- no-escrow RTB default/termination settlement or ownership
-- finalization silently computed a merchant payout of exactly zero,
-- because the prior migration's "actual released escrow principal"
-- authority was applied unconditionally, even when zero escrow rows
-- ever existed for the agreement.
--
-- Root cause, confirmed by direct re-read of the current authoritative
-- bodies: public._rent_to_buy_settle_escrow(agreement_id, budget, ...)
-- iterates `select * from escrow_transactions where
-- rent_to_buy_agreement_id = agreement_id and status = 'funded'` --
-- for an agreement with zero escrow rows, this loop runs zero times
-- and the function correctly, faithfully reports
-- {released_amount: 0, refunded_amount: 0}. The prior phase's callers
-- then used that 0 as the commission base and/or payout amount
-- unconditionally, silently treating "no escrow ever participated"
-- as "zero principal was ever recovered" -- an entirely different
-- fact. The two payout-safety gates made the identical mistake:
-- comparing a payout's amount against a released-escrow sum of 0 for
-- any agreement with no escrow rows, which is trivially exceeded by
-- any positive payout amount.
--
-- This directly contradicts the escrow architecture's own binding
-- contract (src/lib/escrow/config.ts, docs/ESCROW_ARCHITECTURE.md):
-- escrow is additive and best-effort -- when disabled, no escrow row
-- is ever created, and every pre-existing financial workflow must
-- remain byte-identical to before escrow existed. E24's actual-
-- release conservation is correct and remains mandatory wherever
-- escrow genuinely participated; it was never meant to apply to an
-- agreement escrow was never involved with at all.
--
-- Fix: every one of the 4 functions below now establishes an
-- explicit mode, based on persisted row existence, never on the
-- current ESCROW_ENABLED environment value (which cannot describe a
-- historical agreement) and never on the aggregate STATUS of any
-- existing rows (a failed, cancelled, or fully-refunded escrow row
-- still proves the agreement participated in escrow, and must not be
-- treated the same as never having participated at all):
--
--   NO_ESCROW        := not exists (select 1 from escrow_transactions
--                        where rent_to_buy_agreement_id = agreement_id)
--   ESCROW_PARTICIPATING := the negation
--
-- In NO_ESCROW mode, each function recovers its exact pre-E24
-- financial authority (verified against the actual pre-E24
-- authoritative bodies in 20260821190500_rtb_v2_out_of_order_fix_
-- forward.sql, not reconstructed from the general shape of the
-- formula):
--   - _rent_to_buy_settle_default_after_possession: commission base
--     and payout amount both use v_recovered_amount
--     (least(rental_use_amount, held_total)) directly, exactly as
--     before E24 ever existed.
--   - finalize_rent_to_buy_ownership: payout amount is
--     total_purchase_price - commission, exactly as before E24 (its
--     commission base, the possession-period rental/use amount, was
--     never escrow-dependent and needs no change either way).
--   - Both payout-safety gates: the released-principal comparison is
--     skipped entirely when zero escrow rows exist for the agreement
--     -- every OTHER existing check (agreement state, active dispute,
--     merchant restriction, payment-refund status for the booking
--     branch) is completely unaffected and still runs.
--
-- In ESCROW_PARTICIPATING mode (one or more escrow rows exist, in ANY
-- status, including a row with incomplete coverage of the installments
-- actually paid), every one of these functions retains E24's actual-
-- released-principal authority exactly as the prior phase left it --
-- this migration does not weaken that conservation in any way.
--
-- public._rent_to_buy_settle_escrow itself is deliberately NOT
-- touched -- its job (processing whatever funded rows actually exist,
-- correctly producing zero released/zero refunded when none exist) is
-- already correct for both modes; the defect was entirely in how its
-- callers interpreted a legitimate zero.
--
-- _rent_to_buy_settle_default_before_possession is not touched --
-- independently confirmed unaffected: it already creates no commission
-- and no payout in either mode (release budget is always 0), so there
-- was nothing for this regression to break there.
--
-- Concurrency: a new escrow row for this agreement cannot legitimately
-- appear between this function's own NO_ESCROW/ESCROW_PARTICIPATING
-- determination and its later use, because the one path that creates
-- an RTB escrow row (an installment payment capture) requires an
-- installment still in 'scheduled' status
-- (create_rent_to_buy_payment_intent), and both
-- finalize_rent_to_buy_ownership (fully_paid_at is not null -- by
-- definition no installment remains scheduled once every installment
-- is paid) and the default/termination settlement path operate on an
-- agreement whose installment set is not concurrently being extended.
-- No new locking is introduced beyond the pre-existing agreement-row
-- FOR UPDATE already held by every one of these functions.
--
-- The already-existing legacy payout rows this phase was triggered by
-- are not touched by this migration in any way -- no UPDATE, no
-- DELETE, no ledger correction, no fabricated escrow row. They become
-- correctly unblocked purely because the two gate functions' logic is
-- now correct for their (no-escrow) case; normal agreement/dispute/
-- merchant-status/payout-lifecycle checks continue to apply to them
-- exactly as to any other payout.
--
-- E25's partial-refund containment is untouched and unaffected --
-- nothing here creates, reads, or depends on a 'partially_refunded'
-- row. E18 ledger immutability is untouched -- no existing
-- ledger_entries row is read, updated, or deleted.
--
-- SECURITY DEFINER, search_path = public (unchanged -- not this
-- phase's concern to harden), and the existing service_role-only
-- grants are all preserved for every redefined function.
-- ============================================================

create or replace function public._rent_to_buy_settle_default_after_possession(p_agreement_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_agreement public.rent_to_buy_agreements;
  v_rental_use_amount numeric(12,2);
  v_held_total numeric(12,2);
  v_recovered_amount numeric(12,2);
  v_has_escrow boolean;
  v_settle_result jsonb;
  v_actual_released numeric(12,2);
  v_actual_refunded numeric(12,2);
  v_calc record;
  v_commission_amount numeric(12,2) := 0;
  v_commission_id uuid;
  v_late boolean;
begin
  select * into v_agreement from public.rent_to_buy_agreements where id = p_agreement_id for update;
  if v_agreement.settled_at is not null then return; end if;

  v_rental_use_amount := public._rent_to_buy_rental_use_amount(v_agreement, v_agreement.possession_confirmed_at, coalesce(v_agreement.actual_returned_at, now()));

  select coalesce(sum(principal_amount), 0) into v_held_total from public.rent_to_buy_installments where agreement_id = p_agreement_id and status = 'paid';

  v_recovered_amount := least(v_rental_use_amount, v_held_total);

  -- E26: optional-escrow mode, based on persisted row existence, not
  -- on current status or the ESCROW_ENABLED environment value.
  select exists (select 1 from public.escrow_transactions where rent_to_buy_agreement_id = p_agreement_id) into v_has_escrow;

  select public._rent_to_buy_settle_escrow(p_agreement_id, v_recovered_amount, v_agreement.merchant_id, 'system', null, 'rent-to-buy default/termination settlement: capped rental/use recovery')
    into v_settle_result;
  v_actual_released := coalesce((v_settle_result->>'released_amount')::numeric(12,2), 0);
  v_actual_refunded := coalesce((v_settle_result->>'refunded_amount')::numeric(12,2), 0);

  if not v_has_escrow then
    -- No escrow row ever existed for this agreement -- there is
    -- nothing for actual escrow release to measure. Restore the
    -- exact pre-E24, escrow-independent financial authority: the
    -- calculated recovery cap itself.
    v_actual_released := v_recovered_amount;
  end if;

  if v_actual_released > 0 and v_agreement.rental_commission_rate_bps is not null and v_agreement.commission_merchant_plan_id is not null then
    select * into v_calc from public._calculate_unity_commission('rental', v_actual_released, v_agreement.rental_commission_rate_bps);
    v_commission_amount := v_calc.commission_amount;

    insert into public.unity_commissions (
      transaction_type, rent_to_buy_agreement_id, payment_id, listing_id, merchant_id,
      merchant_plan_id, plan_commercial_version, eligible_base,
      standard_rate_bps, standard_rate_base, excess_rate_bps, excess_base,
      commission_amount, currency, calculation_version, status
    ) values (
      'rent_to_buy', p_agreement_id, null, v_agreement.listing_id, v_agreement.merchant_id,
      v_agreement.commission_merchant_plan_id, v_agreement.commission_plan_commercial_version, v_actual_released,
      v_agreement.rental_commission_rate_bps, v_calc.standard_rate_base, 0, 0,
      v_commission_amount, v_agreement.currency, 1, 'pending'
    )
    on conflict (rent_to_buy_agreement_id) where rent_to_buy_agreement_id is not null do nothing
    returning id into v_commission_id;

    if v_commission_id is not null then
      insert into public.unity_commission_history (commission_id, previous_status, new_status, actor_type, reason, calculation_snapshot)
      values (v_commission_id, null, 'pending', 'system', 'rent-to-buy default/termination settlement',
        jsonb_build_object('rental_use_amount', v_rental_use_amount, 'held_total', v_held_total, 'recovered_amount', v_recovered_amount, 'has_escrow', v_has_escrow, 'actual_released_amount', v_actual_released, 'commission_amount', v_commission_amount));
    end if;
  end if;

  if v_actual_released - coalesce(v_commission_amount, 0) > 0 then
    perform public.create_merchant_payout(v_agreement.merchant_id, null, v_actual_released - v_commission_amount, null, p_agreement_id);
  end if;

  v_late := v_agreement.return_deadline_at is not null and coalesce(v_agreement.actual_returned_at, now()) > v_agreement.return_deadline_at;

  if v_agreement.security_deposit_amount is not null and v_agreement.deposit_funded_at is not null
     and v_agreement.deposit_forfeited_at is null and v_agreement.deposit_refunded_at is null then
    if v_late then
      update public.rent_to_buy_agreements set deposit_forfeited_at = now(), deposit_forfeiture_reason = 'late return: the item was not returned by the agreed return deadline' where id = p_agreement_id;
      perform public._rent_to_buy_history(p_agreement_id, 'system', null, 'deposit_forfeited', null, null, jsonb_build_object('reason', 'late_return'));
    else
      update public.rent_to_buy_agreements set deposit_refunded_at = now() where id = p_agreement_id;
    end if;
  end if;

  update public.rent_to_buy_agreements set settled_at = now(), default_reconciliation_pending = false where id = p_agreement_id;
  perform public._rent_to_buy_history(p_agreement_id, 'system', null, 'settled_after_possession', null, null,
    jsonb_build_object('rental_use_amount', v_rental_use_amount, 'recovered_amount', v_recovered_amount, 'has_escrow', v_has_escrow, 'actual_released_amount', v_actual_released, 'actual_refunded_amount', v_actual_refunded, 'commission_amount', v_commission_amount, 'late_return', v_late));
end;
$$;

create or replace function public.finalize_rent_to_buy_ownership(
  p_agreement_id uuid, p_idempotency_key text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_agreement public.rent_to_buy_agreements;
  v_dispute_open boolean;
  v_eligible_base numeric(12,2);
  v_calc record;
  v_commission_amount numeric(12,2) := 0;
  v_commission_id uuid;
  v_has_escrow boolean;
  v_settle_result jsonb;
  v_actual_released numeric(12,2);
  v_payout_amount numeric(12,2);
  v_payout_result jsonb;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;

  select * into v_agreement from public.rent_to_buy_agreements where id = p_agreement_id for update;
  if v_agreement.id is null then raise exception 'agreement not found'; end if;

  if v_agreement.ownership_status = 'customer_owned' then
    return jsonb_build_object('agreement_id', p_agreement_id, 'finalized', true, 'already_finalized', true);
  end if;
  if v_agreement.fully_paid_at is null then
    return jsonb_build_object('agreement_id', p_agreement_id, 'finalized', false, 'reason', 'not_fully_paid');
  end if;
  if v_agreement.status <> 'active' then
    return jsonb_build_object('agreement_id', p_agreement_id, 'finalized', false, 'reason', 'agreement_not_active');
  end if;
  if v_agreement.possession_status <> 'customer_in_possession' then
    return jsonb_build_object('agreement_id', p_agreement_id, 'finalized', false, 'reason', 'possession_not_confirmed');
  end if;
  if v_agreement.completion_window_ends_at is null or v_agreement.completion_window_ends_at > now() then
    return jsonb_build_object('agreement_id', p_agreement_id, 'finalized', false, 'reason', 'completion_window_open');
  end if;

  select exists (select 1 from public.disputes where rent_to_buy_agreement_id = p_agreement_id and status not in ('resolved', 'closed', 'cancelled')) into v_dispute_open;
  if v_dispute_open then
    return jsonb_build_object('agreement_id', p_agreement_id, 'finalized', false, 'reason', 'unresolved_dispute');
  end if;

  update public.rent_to_buy_agreements
  set ownership_status = 'customer_owned', status = 'completed', ownership_transferred_at = now()
  where id = p_agreement_id;
  perform public._rent_to_buy_history(p_agreement_id, 'system', null, 'ownership_transferred', 'active', 'completed');

  -- Commission base is the possession-period rental/use amount --
  -- documented (docs/RENT_TO_BUY.md) as independent of
  -- total_purchase_price/escrow backing. Not changed by E24 or E26.
  v_eligible_base := public._rent_to_buy_rental_use_amount(v_agreement, v_agreement.possession_confirmed_at, now());

  if v_agreement.rental_commission_rate_bps is not null and v_agreement.commission_merchant_plan_id is not null then
    select * into v_calc from public._calculate_unity_commission('rental', v_eligible_base, v_agreement.rental_commission_rate_bps);
    v_commission_amount := v_calc.commission_amount;

    insert into public.unity_commissions (
      transaction_type, rent_to_buy_agreement_id, payment_id, listing_id, merchant_id,
      merchant_plan_id, plan_commercial_version, eligible_base,
      standard_rate_bps, standard_rate_base, excess_rate_bps, excess_base,
      commission_amount, currency, calculation_version, status
    ) values (
      'rent_to_buy', p_agreement_id, null, v_agreement.listing_id, v_agreement.merchant_id,
      v_agreement.commission_merchant_plan_id, v_agreement.commission_plan_commercial_version, v_eligible_base,
      v_agreement.rental_commission_rate_bps, v_calc.standard_rate_base, 0, 0,
      v_commission_amount, v_agreement.currency, 1, 'pending'
    )
    on conflict (rent_to_buy_agreement_id) where rent_to_buy_agreement_id is not null do nothing
    returning id into v_commission_id;

    if v_commission_id is not null then
      insert into public.unity_commission_history (commission_id, previous_status, new_status, actor_type, reason, calculation_snapshot)
      values (v_commission_id, null, 'pending', 'system', 'rent-to-buy ownership completed',
        jsonb_build_object('eligible_base', v_eligible_base, 'rate_bps', v_agreement.rental_commission_rate_bps, 'commission_amount', v_commission_amount));
    end if;
  end if;

  -- E26: optional-escrow mode, based on persisted row existence.
  select exists (select 1 from public.escrow_transactions where rent_to_buy_agreement_id = p_agreement_id) into v_has_escrow;

  select public._rent_to_buy_settle_escrow(p_agreement_id, v_agreement.total_purchase_price, v_agreement.merchant_id, 'system', null, 'rent-to-buy completed: ownership transferred')
    into v_settle_result;
  v_actual_released := coalesce((v_settle_result->>'released_amount')::numeric(12,2), 0);

  if not v_has_escrow then
    -- No escrow row ever existed for this agreement -- restore the
    -- exact pre-E24, escrow-independent financial authority: the
    -- full total_purchase_price.
    v_actual_released := v_agreement.total_purchase_price;
  end if;

  v_payout_amount := greatest(v_actual_released - coalesce(v_commission_amount, 0), 0);

  if v_payout_amount > 0 then
    v_payout_result := public.create_merchant_payout(v_agreement.merchant_id, null, v_payout_amount, null, p_agreement_id);
  end if;

  if v_agreement.security_deposit_amount is not null and v_agreement.deposit_funded_at is not null
     and v_agreement.deposit_forfeited_at is null and v_agreement.deposit_refunded_at is null then
    update public.rent_to_buy_agreements set deposit_refunded_at = now() where id = p_agreement_id;
  end if;

  update public.rent_to_buy_agreements set settled_at = now() where id = p_agreement_id;
  perform public._rent_to_buy_history(p_agreement_id, 'system', null, 'settled_completed', 'completed', 'completed', jsonb_build_object('commission_amount', coalesce(v_commission_amount, 0), 'has_escrow', v_has_escrow, 'actual_released_amount', v_actual_released, 'payout_amount', v_payout_amount));

  return jsonb_build_object('agreement_id', p_agreement_id, 'finalized', true, 'commission_amount', coalesce(v_commission_amount, 0), 'payout_id', v_payout_result->>'payout_id');
end;
$$;

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
  v_has_escrow boolean;
  v_released_total numeric;
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

    -- E26: the E24 released-principal backing check is binding only
    -- in ESCROW-PARTICIPATING mode (one or more escrow rows exist, in
    -- any status). An agreement that never had an escrow row has
    -- nothing for this check to measure -- skipping it here restores
    -- the pre-E24 behavior for that case without weakening E24 for
    -- any agreement that genuinely participated in escrow.
    select exists (select 1 from public.escrow_transactions where rent_to_buy_agreement_id = p_payout.rent_to_buy_agreement_id) into v_has_escrow;
    if v_has_escrow then
      select coalesce(sum(principal_amount), 0) into v_released_total
      from public.escrow_transactions
      where rent_to_buy_agreement_id = p_payout.rent_to_buy_agreement_id and status = 'released';
      if p_payout.amount > v_released_total then
        return 'source_payment_issue';
      end if;
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
  v_has_escrow boolean;
  v_released_total numeric;
begin
  if p_payout.rent_to_buy_agreement_id is not null then
    if exists (select 1 from public.disputes where rent_to_buy_agreement_id = p_payout.rent_to_buy_agreement_id and status not in ('resolved', 'closed', 'cancelled')) then
      return 'compliance_review';
    end if;
    if exists (select 1 from public.profiles where id = p_payout.merchant_id and account_status in ('suspended', 'restricted')) then
      return 'account_restricted';
    end if;

    -- E26: same optional-escrow scoping as the full-eligibility block
    -- above, re-proven immediately before the processing -> paid
    -- transition.
    select exists (select 1 from public.escrow_transactions where rent_to_buy_agreement_id = p_payout.rent_to_buy_agreement_id) into v_has_escrow;
    if v_has_escrow then
      select coalesce(sum(principal_amount), 0) into v_released_total
      from public.escrow_transactions
      where rent_to_buy_agreement_id = p_payout.rent_to_buy_agreement_id and status = 'released';
      if p_payout.amount > v_released_total then
        return 'source_payment_issue';
      end if;
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
