-- ============================================================
-- E24 -- RTB escrow-to-payout conservation
-- ============================================================
-- A fresh audit of the full Rent-to-Buy settlement chain (the
-- escrow-settlement helper, all 3 of its callers resolved to their
-- current authoritative bodies, the payout-creation RPC, both
-- payout-safety gates, the commission calculation, and the generic
-- admin escrow-refund route) confirms a real, deterministic
-- conservation gap -- not hypothetical, and not the same shape as the
-- booking-side gap the prior phase closed (a blanket "any refunded
-- RTB escrow row blocks the payout" rule would break legitimate RTB
-- settlement, since mixed release/refund across rows is the INTENDED
-- outcome whenever the calculated recovery cap falls between rows).
--
-- public._rent_to_buy_settle_escrow(...) deliberately releases whole
-- funded escrow rows to the merchant (oldest first) until its release
-- budget is exhausted, then refunds every remaining row in full --
-- "a row straddling the cap boundary is refunded in full rather than
-- split, so actual merchant recovery can land slightly under the
-- calculated cap but never over it" (its own header comment,
-- 20260821183600_rtb_v2_rpcs.sql). This is a correct, disclosed
-- simplification of the escrow layer. The bug is NOT in that helper --
-- it is that every one of its 2 money-moving callers (
-- _rent_to_buy_settle_default_after_possession,
-- finalize_rent_to_buy_ownership) computed the Unity commission and/or
-- the merchant payout amount from the THEORETICAL requested release
-- budget (the calculated recovery cap / total_purchase_price), never
-- from what the helper actually released, because the helper
-- previously returned `void` and gave its callers no way to know.
--
-- Concretely, with two funded RTB escrow rows of R60 each and a
-- calculated recovery cap of R90: the settlement helper releases the
-- first row (R60) and refunds the second row in full (R60, since the
-- remaining R30 budget cannot cover it) -- actual released principal
-- is R60, not R90. Before this migration,
-- _rent_to_buy_settle_default_after_possession still computed Unity
-- commission on R90 and created a merchant payout for
-- R90 - commission -- a merchant_payouts row (and an immutable
-- ledger_entries row, entry_type='merchant_payout') for materially
-- more than the escrow ever actually released. The equivalent gap
-- exists in finalize_rent_to_buy_ownership: its payout formula was
-- total_purchase_price - commission, which silently assumes every
-- cent of total_purchase_price was actually released -- untrue if,
-- for example, an admin had already manually refunded one of the
-- agreement's funded escrow rows through the generic
-- POST /api/admin/escrow/[id]/refund route before finalization ran
-- (that route has zero rent_to_buy_agreement_id awareness, confirmed
-- by direct trace -- it can refund any single funded row regardless
-- of which domain it belongs to).
--
-- Fix, following the principle this phase's brief itself states --
-- actual escrow settlement -> actual merchant recovery -> commission
-- authority -> payout authority, never the reverse:
--   1. public._rent_to_buy_settle_escrow is changed from `returns
--      void` to `returns jsonb`, reporting back exactly
--      {released_amount, refunded_amount} -- the real totals it just
--      moved. Postgres does not allow changing a function's return
--      type via CREATE OR REPLACE, so this requires DROP + CREATE;
--      no CASCADE is used (nothing holds a catalog-level dependency
--      on it -- its 3 callers invoke it via plain PL/pgSQL `perform`/
--      `select ... into` statements inside their own function bodies,
--      which Postgres does not track as a pg_depend blocker). The
--      function body itself is otherwise byte-for-byte unchanged --
--      same oldest-first order, same FOR UPDATE row locking, same
--      whole-row-only release/refund logic, same signature, same
--      SECURITY DEFINER / search_path = public / service_role-only
--      grants.
--   2. _rent_to_buy_settle_default_after_possession and
--      finalize_rent_to_buy_ownership are reordered to call the
--      settlement helper FIRST and use its reported actual_released
--      amount for commission (the former only -- see below) and
--      payout, instead of the pre-settlement theoretical figure.
--      _rent_to_buy_settle_default_before_possession needs no change
--      at all: its release budget is always literally 0, it never
--      computes a commission or payout, and it already calls the
--      helper via a bare `perform` (which discards any return value
--      regardless of type) -- it is unaffected by the return-type
--      change and is not touched by this migration.
--   3. finalize_rent_to_buy_ownership's commission base (the
--      possession-period rental/use amount) is explicitly NOT changed
--      -- docs/RENT_TO_BUY.md defines that commission base as the
--      rental/use rate over the actual possession period, independent
--      of total_purchase_price or escrow backing; only its PAYOUT
--      formula (which does depend on total_purchase_price) is
--      corrected to use the actual released amount instead.
--   4. As defense in depth -- not as the primary fix, since the
--      primary fix prevents an incorrect amount from ever being
--      written to the (immutable) ledger in the first place -- the
--      RTB branches of both public._merchant_payout_full_eligibility_block
--      and public._merchant_payout_still_safe_to_pay_block now also
--      block (same 'source_payment_issue' category the booking branch
--      already uses) if a payout's amount ever exceeds the sum of
--      principal_amount across that agreement's RELEASED escrow rows.
--      This is deliberately NOT "any refunded row blocks the payout"
--      (which the brief explicitly warns would break legitimate mixed
--      settlement) -- it only compares the payout amount against the
--      actual released total, which is unaffected by how many rows
--      were legitimately refunded alongside it.
--
-- In the normal, nothing-went-wrong case this changes no observable
-- behavior at all: when every funded row is released in full (no
-- straddling row, no prior manual refund), actual_released equals
-- the theoretical figure exactly, so commission and payout amounts
-- are byte-identical to before.
--
-- E18 ledger immutability remains binding -- no existing
-- ledger_entries row is read, updated, or deleted by this migration;
-- this only prevents a wrong amount from being written at the one
-- point (payout creation) where it is still possible to compute it
-- correctly. No clawback automation is introduced for any payout that
-- may already have been created or paid with the old, uncorrected
-- formula -- see this phase's final report for that risk.
-- ============================================================

drop function public._rent_to_buy_settle_escrow(uuid, numeric, uuid, text, uuid, text);

create function public._rent_to_buy_settle_escrow(
  p_agreement_id uuid,
  p_release_amount_to_merchant numeric,
  p_released_to uuid,
  p_actor_type text,
  p_actor_id uuid,
  p_reason text
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_row public.escrow_transactions;
  v_remaining numeric := coalesce(p_release_amount_to_merchant, 0);
  v_released_total numeric := 0;
  v_refunded_total numeric := 0;
begin
  for v_row in
    select * from public.escrow_transactions
    where rent_to_buy_agreement_id = p_agreement_id and status = 'funded'
    order by created_at asc
    for update
  loop
    if v_remaining >= v_row.principal_amount then
      perform public._escrow_transaction_transition(
        v_row.id, 'released', array['funded']::escrow_status[],
        p_actor_type, p_actor_id, 'released', p_reason, null, p_released_to, null, null, null
      );
      v_remaining := v_remaining - v_row.principal_amount;
      v_released_total := v_released_total + v_row.principal_amount;
    else
      perform public._escrow_transaction_transition(
        v_row.id, 'refunded', array['funded']::escrow_status[],
        p_actor_type, p_actor_id, 'refunded', p_reason, null, null, v_row.principal_amount, null, null
      );
      v_refunded_total := v_refunded_total + v_row.principal_amount;
    end if;
  end loop;

  return jsonb_build_object('released_amount', v_released_total, 'refunded_amount', v_refunded_total);
end;
$$;
revoke all on function public._rent_to_buy_settle_escrow(uuid, numeric, uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public._rent_to_buy_settle_escrow(uuid, numeric, uuid, text, uuid, text) to service_role;

create or replace function public._rent_to_buy_settle_default_after_possession(p_agreement_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_agreement public.rent_to_buy_agreements;
  v_rental_use_amount numeric(12,2);
  v_held_total numeric(12,2);
  v_recovered_amount numeric(12,2);
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

  -- E24: settle escrow against the calculated cap FIRST, and derive
  -- commission/payout from what was ACTUALLY released -- not from
  -- v_recovered_amount itself, which the whole-row settlement helper
  -- may not fully honor if a row straddles the cap boundary.
  select public._rent_to_buy_settle_escrow(p_agreement_id, v_recovered_amount, v_agreement.merchant_id, 'system', null, 'rent-to-buy default/termination settlement: capped rental/use recovery')
    into v_settle_result;
  v_actual_released := coalesce((v_settle_result->>'released_amount')::numeric(12,2), 0);
  v_actual_refunded := coalesce((v_settle_result->>'refunded_amount')::numeric(12,2), 0);

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
        jsonb_build_object('rental_use_amount', v_rental_use_amount, 'held_total', v_held_total, 'recovered_amount', v_recovered_amount, 'actual_released_amount', v_actual_released, 'commission_amount', v_commission_amount));
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
    jsonb_build_object('rental_use_amount', v_rental_use_amount, 'recovered_amount', v_recovered_amount, 'actual_released_amount', v_actual_released, 'actual_refunded_amount', v_actual_refunded, 'commission_amount', v_commission_amount, 'late_return', v_late));
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
  -- total_purchase_price/escrow backing. Not changed by E24.
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

  -- E24: settle escrow against total_purchase_price FIRST, and base
  -- the payout on what was ACTUALLY released -- not on
  -- total_purchase_price itself, which silently assumed every cent of
  -- it was still backed by a funded escrow row at this exact moment
  -- (untrue if, for example, a row was already manually refunded
  -- through the generic admin escrow-refund route before finalization
  -- ran).
  select public._rent_to_buy_settle_escrow(p_agreement_id, v_agreement.total_purchase_price, v_agreement.merchant_id, 'system', null, 'rent-to-buy completed: ownership transferred')
    into v_settle_result;
  v_actual_released := coalesce((v_settle_result->>'released_amount')::numeric(12,2), 0);

  v_payout_amount := greatest(v_actual_released - coalesce(v_commission_amount, 0), 0);

  if v_payout_amount > 0 then
    v_payout_result := public.create_merchant_payout(v_agreement.merchant_id, null, v_payout_amount, null, p_agreement_id);
  end if;

  if v_agreement.security_deposit_amount is not null and v_agreement.deposit_funded_at is not null
     and v_agreement.deposit_forfeited_at is null and v_agreement.deposit_refunded_at is null then
    update public.rent_to_buy_agreements set deposit_refunded_at = now() where id = p_agreement_id;
  end if;

  update public.rent_to_buy_agreements set settled_at = now() where id = p_agreement_id;
  perform public._rent_to_buy_history(p_agreement_id, 'system', null, 'settled_completed', 'completed', 'completed', jsonb_build_object('commission_amount', coalesce(v_commission_amount, 0), 'actual_released_amount', v_actual_released, 'payout_amount', v_payout_amount));

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

    -- E24: defense in depth -- the payout amount is now always
    -- derived from actual released escrow principal at creation time
    -- (see _rent_to_buy_settle_default_after_possession /
    -- finalize_rent_to_buy_ownership), but this independently proves
    -- the invariant at the advancement gate too. Deliberately NOT
    -- "any refunded row blocks the payout" -- legitimate RTB
    -- settlement always leaves some rows refunded alongside released
    -- ones; only comparing against the released total is safe.
    select coalesce(sum(principal_amount), 0) into v_released_total
    from public.escrow_transactions
    where rent_to_buy_agreement_id = p_payout.rent_to_buy_agreement_id and status = 'released';
    if p_payout.amount > v_released_total then
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
  v_released_total numeric;
begin
  if p_payout.rent_to_buy_agreement_id is not null then
    if exists (select 1 from public.disputes where rent_to_buy_agreement_id = p_payout.rent_to_buy_agreement_id and status not in ('resolved', 'closed', 'cancelled')) then
      return 'compliance_review';
    end if;
    if exists (select 1 from public.profiles where id = p_payout.merchant_id and account_status in ('suspended', 'restricted')) then
      return 'account_restricted';
    end if;

    -- E24: same defense-in-depth backing check as the full-eligibility
    -- block above, re-proven immediately before the processing -> paid
    -- transition.
    select coalesce(sum(principal_amount), 0) into v_released_total
    from public.escrow_transactions
    where rent_to_buy_agreement_id = p_payout.rent_to_buy_agreement_id and status = 'released';
    if p_payout.amount > v_released_total then
      return 'source_payment_issue';
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
