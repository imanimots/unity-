-- ============================================================
-- Rent-to-Buy V2 -- fix-forward correction, found via live corrective-
-- verification testing against the two just-applied V2 migrations.
-- ============================================================
-- BUG 1 (out-of-order clobbering -- the exact Subscription V2 lesson,
-- missed this time for 4 specific functions): 20260821183600's own
-- CREATE OR REPLACE for create_rent_to_buy_request, accept_rent_to_buy_
-- request, confirm_rent_to_buy_return_completed, and confirm_rent_to_
-- buy_recovered was built from the ORIGINAL Phase 5 bodies
-- (20260827000005) without incorporating the single-physical-item
-- inventory-locking logic that 20260828000001 LATER added to those same
-- four functions (barter/RTB lock checks, active-booking check,
-- quantity_available reserve-at-accept/restore-at-return). Because
-- 20260821183600 is dated Aug 21 but was applied (via --include-all)
-- AFTER the already-live Aug 28 version, it silently overwrote and
-- REMOVED all inventory-locking logic from these four functions --
-- confirmed live via the INVENTORY test section of
-- scripts/verify-rent-to-buy-phase5.mjs (checks A, D, E, F, G, H, J1,
-- J2 all failed: RTB could be created/accepted against
-- already-committed listings, and other domains could claim a listing
-- an active RTB agreement had reserved).
--
-- Fix: rebuild all four functions as TRUE supersets -- the Aug 28
-- inventory-locking logic PLUS the V2 economic additions (possession-
-- trigger/rental-rate/wear-damage/grace/return-window snapshot columns,
-- RENTAL commission-rate snapshot at accept, actual_returned_at +
-- deferred settlement at return/recovery confirmation).
--
-- BUG 2 (PL/pgSQL record-to-composite-type cast): finalize_rent_to_buy_
-- ownership, _rent_to_buy_settle_default_after_possession, and
-- initiate_rent_to_buy_default all declared `v_agreement record;` and
-- then passed that generic record variable to _rent_to_buy_rental_use_
-- amount()/_rent_to_buy_default_eligibility(), both of which take a
-- concrete `public.rent_to_buy_agreements` composite parameter --
-- PL/pgSQL cannot implicitly cast a generic record to a specific row
-- type across a function call boundary ("cannot cast type record to
-- rent_to_buy_agreements", confirmed live). Fix: declare v_agreement
-- with the concrete row type in all three functions -- the same
-- pattern already used correctly everywhere else in this codebase
-- (e.g. every _escrow_transaction_*_block(p_escrow public.escrow_
-- transactions) caller).
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

-- ------------------------------------------------------------
-- create_rent_to_buy_request -- true superset.
-- ------------------------------------------------------------
create or replace function public.create_rent_to_buy_request(
  p_customer_id uuid,
  p_listing_id uuid,
  p_request_id uuid default null,
  p_offer_id uuid default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_terms record;
  v_listing record;
  v_agreement_id uuid;
  v_seq int;
  v_running_total numeric(12,2);
  v_this_amount numeric(12,2);
  v_due date;
  v_interval interval;
  v_request_hash text;
  v_idem record;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  if p_customer_id is null then raise exception 'not authenticated'; end if;

  select id, merchant_id, status, is_test, quantity_available into v_listing from public.listings where id = p_listing_id;
  if v_listing.id is null then raise exception 'listing not found'; end if;
  if v_listing.merchant_id = p_customer_id then raise exception 'cannot enter a rent-to-buy agreement on your own listing'; end if;
  if v_listing.status <> 'active' then raise exception 'listing is not currently active'; end if;

  select * into v_terms from public.rent_to_buy_listing_terms where listing_id = p_listing_id and enabled = true;
  if v_terms.id is null then raise exception 'this listing does not have rent-to-buy enabled'; end if;

  if exists (select 1 from public.barter_locked_listings where listing_id = p_listing_id) then
    raise exception 'this listing is currently committed to a barter agreement';
  end if;
  if exists (select 1 from public.rent_to_buy_locked_listings where listing_id = p_listing_id) then
    raise exception 'this listing is currently committed to another rent-to-buy agreement';
  end if;
  if exists (
    select 1 from public.bookings
    where listing_id = p_listing_id
      and status not in ('rejected', 'expired', 'cancelled_by_renter', 'cancelled_by_merchant', 'completed')
  ) then
    raise exception 'this listing currently has an active rental booking';
  end if;
  if coalesce(v_listing.quantity_available, 0) < 1 then
    raise exception 'this listing has no remaining inventory available';
  end if;

  perform public._rent_to_buy_assert_parties_verified(v_listing.merchant_id, p_customer_id);

  v_request_hash := md5(coalesce(p_listing_id::text, '') || '|' || coalesce(p_customer_id::text, '') || '|' || coalesce(v_terms.terms_version::text, ''));
  if p_idempotency_key is not null then
    select request_hash, result into v_idem from public.idempotency_keys
    where merchant_id = p_customer_id and operation = 'create_rent_to_buy_request' and idempotency_key = p_idempotency_key;
    if found then
      if v_idem.request_hash is distinct from v_request_hash then raise exception 'idempotency key already used with a different request'; end if;
      return v_idem.result;
    end if;
  end if;

  insert into public.rent_to_buy_agreements (
    listing_id, merchant_id, customer_id, request_id, offer_id, status, possession_status, ownership_status,
    currency, total_purchase_price, installment_amount, payment_frequency, installment_count,
    security_deposit_amount, early_payoff_allowed, early_payoff_policy, cure_allowed, cure_policy, terms_version,
    possession_trigger_type, possession_trigger_value, rental_use_rate_amount, rental_use_rate_unit,
    wear_damage_standard, grace_period_days, return_window_days,
    is_test
  ) values (
    p_listing_id, v_listing.merchant_id, p_customer_id, p_request_id, p_offer_id, 'pending_merchant_acceptance', 'not_delivered', 'merchant_owned',
    v_terms.currency, v_terms.total_purchase_price, v_terms.installment_amount, v_terms.payment_frequency, v_terms.installment_count,
    v_terms.security_deposit_amount, v_terms.early_payoff_allowed, v_terms.early_payoff_policy, v_terms.default_cure_allowed, v_terms.cure_policy, v_terms.terms_version,
    v_terms.possession_trigger_type, v_terms.possession_trigger_value, v_terms.rental_use_rate_amount, v_terms.rental_use_rate_unit,
    v_terms.wear_damage_standard, v_terms.grace_period_days, v_terms.return_window_days,
    coalesce(v_listing.is_test, false)
  ) returning id into v_agreement_id;

  v_interval := case v_terms.payment_frequency
    when 'weekly' then interval '7 days'
    when 'biweekly' then interval '14 days'
    else interval '1 month'
  end;

  v_due := current_date + v_interval;
  v_running_total := 0;
  for v_seq in 1..v_terms.installment_count loop
    if v_seq = v_terms.installment_count then
      v_this_amount := v_terms.total_purchase_price - v_running_total;
    else
      v_this_amount := round(v_terms.total_purchase_price / v_terms.installment_count, 2);
    end if;
    v_running_total := v_running_total + v_this_amount;

    insert into public.rent_to_buy_installments (agreement_id, sequence, due_date, principal_amount, status)
    values (v_agreement_id, v_seq, v_due, v_this_amount, 'scheduled');

    if v_seq = 1 then
      update public.rent_to_buy_agreements set first_due_date = v_due where id = v_agreement_id;
    end if;
    if v_seq = v_terms.installment_count then
      update public.rent_to_buy_agreements set final_due_date = v_due where id = v_agreement_id;
    end if;

    v_due := v_due + v_interval;
  end loop;

  perform public._rent_to_buy_history(v_agreement_id, 'customer', p_customer_id, 'requested', null, 'pending_merchant_acceptance');

  v_result := jsonb_build_object('agreement_id', v_agreement_id, 'status', 'pending_merchant_acceptance');
  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_customer_id, 'create_rent_to_buy_request', p_idempotency_key, v_request_hash, v_result);
  end if;
  return v_result;
end;
$$;

-- ------------------------------------------------------------
-- accept_rent_to_buy_request -- true superset.
-- ------------------------------------------------------------
create or replace function public.accept_rent_to_buy_request(
  p_merchant_id uuid, p_agreement_id uuid, p_idempotency_key text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_agreement record;
  v_listing record;
  v_plan_id text;
  v_plan record;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  select * into v_agreement from public.rent_to_buy_agreements where id = p_agreement_id for update;
  if v_agreement.id is null then raise exception 'agreement not found'; end if;
  if v_agreement.merchant_id <> p_merchant_id then raise exception 'not the merchant of this agreement'; end if;
  if v_agreement.status <> 'pending_merchant_acceptance' then
    raise exception 'agreement is in status % and cannot be accepted from here', v_agreement.status;
  end if;

  perform public._rent_to_buy_assert_parties_verified(v_agreement.merchant_id, v_agreement.customer_id);

  select id, quantity_available into v_listing from public.listings where id = v_agreement.listing_id for update;
  if exists (select 1 from public.barter_locked_listings where listing_id = v_agreement.listing_id) then
    raise exception 'this listing is currently committed to a barter agreement';
  end if;
  if exists (select 1 from public.rent_to_buy_locked_listings where listing_id = v_agreement.listing_id and agreement_id <> p_agreement_id) then
    raise exception 'this listing is currently committed to another rent-to-buy agreement';
  end if;
  if exists (
    select 1 from public.bookings
    where listing_id = v_agreement.listing_id
      and status not in ('rejected', 'expired', 'cancelled_by_renter', 'cancelled_by_merchant', 'completed')
  ) then
    raise exception 'this listing currently has an active rental booking';
  end if;
  if coalesce(v_listing.quantity_available, 0) < 1 then
    raise exception 'this listing has no remaining inventory available';
  end if;

  -- Rule 29: applicable RENTAL commission rate is snapshotted at
  -- acceptance -- a later subscription upgrade/downgrade never rewrites
  -- an already-accepted agreement's rate.
  v_plan_id := public._get_effective_merchant_plan_id(v_agreement.merchant_id);
  select id, rental_commission_bps, commercial_version into v_plan from public.merchant_subscription_plans where id = v_plan_id;

  update public.listings set quantity_available = quantity_available - 1 where id = v_agreement.listing_id;
  update public.rent_to_buy_agreements
  set status = 'awaiting_first_payment', accepted_at = now(),
      rental_commission_rate_bps = v_plan.rental_commission_bps,
      commission_merchant_plan_id = v_plan.id,
      commission_plan_commercial_version = v_plan.commercial_version
  where id = p_agreement_id;
  perform public._rent_to_buy_history(p_agreement_id, 'merchant', p_merchant_id, 'accepted', 'pending_merchant_acceptance', 'awaiting_first_payment');

  v_result := jsonb_build_object('agreement_id', p_agreement_id, 'status', 'awaiting_first_payment');
  return v_result;
end;
$$;

-- ------------------------------------------------------------
-- confirm_rent_to_buy_return_completed -- true superset.
-- ------------------------------------------------------------
create or replace function public.confirm_rent_to_buy_return_completed(
  p_admin_id uuid, p_case_id uuid, p_idempotency_key text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_case record;
  v_agreement public.rent_to_buy_agreements;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  select * into v_case from public.rent_to_buy_return_cases where id = p_case_id for update;
  if v_case.id is null then raise exception 'return case not found'; end if;
  if v_case.status not in ('requested', 'scheduled') then raise exception 'return case is in status % and cannot be confirmed returned from here', v_case.status; end if;

  select * into v_agreement from public.rent_to_buy_agreements where id = v_case.agreement_id for update;

  update public.rent_to_buy_return_cases set status = 'returned', resolved_at = now() where id = p_case_id;
  update public.rent_to_buy_agreements
  set possession_status = 'returned_to_merchant', actual_returned_at = coalesce(actual_returned_at, now())
  where id = v_case.agreement_id;

  -- Only restore inventory if this agreement had actually reserved a
  -- unit (i.e. it reached acceptance) and ownership never transferred.
  if v_agreement.ownership_status = 'merchant_owned' and v_agreement.status <> 'pending_merchant_acceptance' then
    update public.listings set quantity_available = quantity_available + 1 where id = v_agreement.listing_id;
  end if;

  perform public._rent_to_buy_history(v_case.agreement_id, 'admin', p_admin_id, 'return_confirmed', v_agreement.possession_status::text, 'returned_to_merchant', jsonb_build_object('case_id', p_case_id));

  if v_agreement.status in ('defaulted', 'cancelled') then
    perform public._rent_to_buy_settle_default_after_possession(v_case.agreement_id);
  end if;

  return jsonb_build_object('case_id', p_case_id, 'agreement_id', v_case.agreement_id, 'possession_status', 'returned_to_merchant');
end;
$$;

-- ------------------------------------------------------------
-- confirm_rent_to_buy_recovered -- true superset.
-- ------------------------------------------------------------
create or replace function public.confirm_rent_to_buy_recovered(
  p_admin_id uuid, p_case_id uuid, p_idempotency_key text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_case record;
  v_agreement public.rent_to_buy_agreements;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  select * into v_case from public.rent_to_buy_return_cases where id = p_case_id for update;
  if v_case.id is null then raise exception 'return case not found'; end if;
  if v_case.case_type <> 'recovery' then raise exception 'this case is not a recovery case'; end if;
  if v_case.status <> 'recovery_pending' then raise exception 'recovery case is in status % and cannot be marked recovered from here', v_case.status; end if;

  select * into v_agreement from public.rent_to_buy_agreements where id = v_case.agreement_id for update;

  update public.rent_to_buy_return_cases set status = 'recovered', resolved_at = now() where id = p_case_id;
  update public.rent_to_buy_agreements
  set possession_status = 'recovered', actual_returned_at = coalesce(actual_returned_at, now())
  where id = v_case.agreement_id;

  if v_agreement.ownership_status = 'merchant_owned' and v_agreement.status <> 'pending_merchant_acceptance' then
    update public.listings set quantity_available = quantity_available + 1 where id = v_agreement.listing_id;
  end if;

  perform public._rent_to_buy_history(v_case.agreement_id, 'admin', p_admin_id, 'recovery_confirmed', v_agreement.possession_status::text, 'recovered', jsonb_build_object('case_id', p_case_id));

  if v_agreement.status in ('defaulted', 'cancelled') then
    perform public._rent_to_buy_settle_default_after_possession(v_case.agreement_id);
  end if;

  return jsonb_build_object('case_id', p_case_id, 'agreement_id', v_case.agreement_id, 'possession_status', 'recovered');
end;
$$;

-- ------------------------------------------------------------
-- BUG 2: record-to-composite-type cast fix. Same bodies as
-- 20260821183600, only the v_agreement declaration type changes.
-- ------------------------------------------------------------
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

  v_payout_amount := greatest(v_agreement.total_purchase_price - coalesce(v_commission_amount, 0), 0);

  perform public._rent_to_buy_settle_escrow(p_agreement_id, v_agreement.total_purchase_price, v_agreement.merchant_id, 'system', null, 'rent-to-buy completed: ownership transferred');

  if v_payout_amount > 0 then
    v_payout_result := public.create_merchant_payout(v_agreement.merchant_id, null, v_payout_amount, null, p_agreement_id);
  end if;

  if v_agreement.security_deposit_amount is not null and v_agreement.deposit_funded_at is not null
     and v_agreement.deposit_forfeited_at is null and v_agreement.deposit_refunded_at is null then
    update public.rent_to_buy_agreements set deposit_refunded_at = now() where id = p_agreement_id;
  end if;

  update public.rent_to_buy_agreements set settled_at = now() where id = p_agreement_id;
  perform public._rent_to_buy_history(p_agreement_id, 'system', null, 'settled_completed', 'completed', 'completed', jsonb_build_object('commission_amount', coalesce(v_commission_amount, 0), 'payout_amount', v_payout_amount));

  return jsonb_build_object('agreement_id', p_agreement_id, 'finalized', true, 'commission_amount', coalesce(v_commission_amount, 0), 'payout_id', v_payout_result->>'payout_id');
end;
$$;

create or replace function public._rent_to_buy_settle_default_after_possession(p_agreement_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_agreement public.rent_to_buy_agreements;
  v_rental_use_amount numeric(12,2);
  v_held_total numeric(12,2);
  v_recovered_amount numeric(12,2);
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

  if v_recovered_amount > 0 and v_agreement.rental_commission_rate_bps is not null and v_agreement.commission_merchant_plan_id is not null then
    select * into v_calc from public._calculate_unity_commission('rental', v_recovered_amount, v_agreement.rental_commission_rate_bps);
    v_commission_amount := v_calc.commission_amount;

    insert into public.unity_commissions (
      transaction_type, rent_to_buy_agreement_id, payment_id, listing_id, merchant_id,
      merchant_plan_id, plan_commercial_version, eligible_base,
      standard_rate_bps, standard_rate_base, excess_rate_bps, excess_base,
      commission_amount, currency, calculation_version, status
    ) values (
      'rent_to_buy', p_agreement_id, null, v_agreement.listing_id, v_agreement.merchant_id,
      v_agreement.commission_merchant_plan_id, v_agreement.commission_plan_commercial_version, v_recovered_amount,
      v_agreement.rental_commission_rate_bps, v_calc.standard_rate_base, 0, 0,
      v_commission_amount, v_agreement.currency, 1, 'pending'
    )
    on conflict (rent_to_buy_agreement_id) where rent_to_buy_agreement_id is not null do nothing
    returning id into v_commission_id;

    if v_commission_id is not null then
      insert into public.unity_commission_history (commission_id, previous_status, new_status, actor_type, reason, calculation_snapshot)
      values (v_commission_id, null, 'pending', 'system', 'rent-to-buy default/termination settlement',
        jsonb_build_object('rental_use_amount', v_rental_use_amount, 'held_total', v_held_total, 'recovered_amount', v_recovered_amount, 'commission_amount', v_commission_amount));
    end if;
  end if;

  perform public._rent_to_buy_settle_escrow(p_agreement_id, v_recovered_amount, v_agreement.merchant_id, 'system', null, 'rent-to-buy default/termination settlement: capped rental/use recovery');

  if v_recovered_amount - coalesce(v_commission_amount, 0) > 0 then
    perform public.create_merchant_payout(v_agreement.merchant_id, null, v_recovered_amount - v_commission_amount, null, p_agreement_id);
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
    jsonb_build_object('rental_use_amount', v_rental_use_amount, 'recovered_amount', v_recovered_amount, 'commission_amount', v_commission_amount, 'late_return', v_late));
end;
$$;

create or replace function public.initiate_rent_to_buy_default(
  p_merchant_id uuid, p_agreement_id uuid, p_reason text, p_idempotency_key text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_agreement public.rent_to_buy_agreements;
  v_new_possession public.rent_to_buy_possession_status;
  v_request_hash text;
  v_idem record;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  if p_reason is null or length(trim(p_reason)) = 0 then raise exception 'a reason is required'; end if;

  select * into v_agreement from public.rent_to_buy_agreements where id = p_agreement_id for update;
  if v_agreement.id is null then raise exception 'agreement not found'; end if;
  if v_agreement.merchant_id <> p_merchant_id then raise exception 'not the merchant of this agreement'; end if;
  if v_agreement.status <> 'active' then raise exception 'agreement is in status % and cannot be defaulted from here', v_agreement.status; end if;
  if v_agreement.ownership_status = 'customer_owned' then raise exception 'ownership has already transferred -- this agreement cannot default'; end if;
  if not public._rent_to_buy_default_eligibility(v_agreement) then
    raise exception 'default_not_eligible: no installment is currently past its grace period';
  end if;

  v_request_hash := md5(coalesce(p_agreement_id::text, '') || '|' || coalesce(p_reason, ''));
  if p_idempotency_key is not null then
    select request_hash, result into v_idem from public.idempotency_keys
    where merchant_id = p_merchant_id and operation = 'initiate_rent_to_buy_default' and idempotency_key = p_idempotency_key;
    if found then
      if v_idem.request_hash is distinct from v_request_hash then raise exception 'idempotency key already used with a different request'; end if;
      return v_idem.result;
    end if;
  end if;

  v_new_possession := case when v_agreement.possession_status = 'customer_in_possession' then 'return_required'::public.rent_to_buy_possession_status else v_agreement.possession_status end;

  update public.rent_to_buy_agreements
  set status = 'defaulted', possession_status = v_new_possession, default_at = now(), default_reason = p_reason, default_reconciliation_pending = true,
      return_deadline_at = case when v_new_possession = 'return_required' then now() + (v_agreement.return_window_days || ' days')::interval else return_deadline_at end
  where id = p_agreement_id;

  perform public._rent_to_buy_history(p_agreement_id, 'merchant', p_merchant_id, 'formal_default_initiated', 'active', 'defaulted', jsonb_build_object('reason', p_reason));

  if v_new_possession <> 'return_required' then
    perform public._rent_to_buy_settle_default_before_possession(p_agreement_id);
  end if;

  v_result := jsonb_build_object('agreement_id', p_agreement_id, 'status', 'defaulted', 'possession_status', v_new_possession);
  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_merchant_id, 'initiate_rent_to_buy_default', p_idempotency_key, v_request_hash, v_result);
  end if;
  return v_result;
end;
$$;
