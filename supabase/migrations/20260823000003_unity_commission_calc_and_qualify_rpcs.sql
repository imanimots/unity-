-- ============================================================
-- Unity Phase 2 -- Commission Framework
-- The central commission calculation (SQL side) + the two qualification
-- RPCs. Mirrors Phase 7's qualify_sale_affiliate_commission /
-- qualify_rental_payment_affiliate_commission shape and reasoning
-- almost exactly -- trusted internal RPCs, service-role only, called
-- from the orchestrator layer in JS right after a payment reaches
-- 'captured' (never from a route or client-claimed event).
--
-- _calculate_unity_commission() is the SQL-side mirror of
-- src/lib/commissions/calculate.ts's calculateUnityCommission() -- both
-- read the plan's own rate (never a second hardcoded copy) and implement
-- the identical high-value-excess formula, so the two can never silently
-- diverge on which digits belong to which layer -- only the arithmetic
-- itself is duplicated (unavoidable: Postgres cannot call out to the TS
-- implementation), deliberately kept small for exactly that reason.
--
-- High-value excess (Phase 2 Rule 2) applies to sales only, above
-- R100,000, at a fixed 1% that REPLACES (never adds to) the plan rate
-- on the amount above the threshold. Rentals never have an excess
-- portion (rental_charge amounts are never realistically at this scale,
-- and Rule 2 is stated for sales only).
-- ============================================================

create or replace function public._calculate_unity_commission(
  p_transaction_type text,
  p_eligible_base numeric,
  p_standard_rate_bps integer
)
returns table (
  standard_rate_base numeric,
  excess_rate_bps integer,
  excess_base numeric,
  commission_amount numeric
)
language plpgsql
stable
as $$
declare
  v_threshold constant numeric := 100000;
  v_high_value_excess_rate_bps constant integer := 100; -- exactly 1.00%, sale-only
  v_standard_base numeric;
  v_excess_base numeric;
  v_excess_rate integer;
  v_standard_portion numeric;
  v_excess_portion numeric;
begin
  if p_transaction_type = 'sale' then
    v_standard_base := least(p_eligible_base, v_threshold);
    v_excess_base := greatest(p_eligible_base - v_threshold, 0);
  else
    v_standard_base := p_eligible_base;
    v_excess_base := 0;
  end if;

  v_excess_rate := case when v_excess_base > 0 then v_high_value_excess_rate_bps else 0 end;
  v_standard_portion := round(v_standard_base * p_standard_rate_bps / 10000.0, 2);
  v_excess_portion := round(v_excess_base * v_excess_rate / 10000.0, 2);

  return query select v_standard_base, v_excess_rate, v_excess_base, v_standard_portion + v_excess_portion;
end;
$$;

-- ─────────────────────────────────────────
-- QUALIFY_SALE_UNITY_COMMISSION -- trusted internal, called from
-- chargeOrderPayment() right after the order payment reaches 'captured'
-- (the same hook point as qualify_sale_affiliate_commission -- both
-- fire from the same event, independently).
-- ─────────────────────────────────────────
create or replace function public.qualify_sale_unity_commission(
  p_order_id uuid,
  p_payment_id uuid,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order record;
  v_payment record;
  v_plan_id text;
  v_plan record;
  v_calc record;
  v_commission_id uuid;
  v_eligible_base numeric(12,2);
  v_request_hash text;
  v_idem record;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;

  v_request_hash := md5(coalesce(p_order_id::text, '') || '|' || coalesce(p_payment_id::text, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_order_id and operation = 'qualify_sale_unity_commission' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  -- Idempotent by construction regardless of the check above --
  -- unity_commissions.payment_id is unique at the database level.
  select id into v_commission_id from public.unity_commissions where payment_id = p_payment_id;
  if v_commission_id is not null then
    v_result := jsonb_build_object('qualified', false, 'reason', 'already_qualified', 'commission_id', v_commission_id);
    if p_idempotency_key is not null then
      insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
      values (p_order_id, 'qualify_sale_unity_commission', p_idempotency_key, v_request_hash, v_result)
      on conflict do nothing;
    end if;
    return v_result;
  end if;

  select id, listing_id, seller_id, total_amount, shipping_fee, status into v_order
  from public.orders where id = p_order_id;
  if v_order.id is null then
    raise exception 'order not found';
  end if;

  select id, order_id, payment_type, status, amount, currency into v_payment
  from public.payments where id = p_payment_id and order_id = p_order_id;
  if v_payment.id is null or v_payment.payment_type <> 'order_payment' or v_payment.status <> 'captured' then
    v_result := jsonb_build_object('qualified', false, 'reason', 'payment_not_eligible');
    return v_result;
  end if;

  -- Unresolved dispute freezes qualification -- it is simply not created
  -- yet, not held after the fact (a dispute cannot exist before the
  -- payment that triggers this RPC has itself captured).
  if exists (
    select 1 from public.disputes
    where order_id = p_order_id and status not in ('resolved', 'closed', 'cancelled')
  ) then
    v_result := jsonb_build_object('qualified', false, 'reason', 'unresolved_dispute');
    return v_result;
  end if;

  -- Phase 1's own resolution algorithm, reused directly -- never a
  -- second copy of plan-rate logic.
  v_plan_id := public._get_effective_merchant_plan_id(v_order.seller_id);
  select id, sales_commission_bps, commercial_version into v_plan
  from public.merchant_subscription_plans where id = v_plan_id;
  if v_plan.id is null then
    raise exception 'merchant_subscription_plans is missing an entry for resolved plan id %', v_plan_id;
  end if;

  -- Rule 1/5: final selling price minus shipping (delivery) only --
  -- orders have no deposit/insurance/damage-reimbursement/provider-fee
  -- line items to exclude; total_amount is already the seller-funded,
  -- post-discount final price (immutable snapshot, protected from
  -- mutation since order creation).
  v_eligible_base := greatest(v_order.total_amount - coalesce(v_order.shipping_fee, 0), 0);

  select * into v_calc from public._calculate_unity_commission('sale', v_eligible_base, v_plan.sales_commission_bps);

  insert into public.unity_commissions (
    transaction_type, order_id, payment_id, listing_id, merchant_id,
    merchant_plan_id, plan_commercial_version, eligible_base,
    standard_rate_bps, standard_rate_base, excess_rate_bps, excess_base,
    commission_amount, currency, calculation_version, status
  ) values (
    'sale', p_order_id, p_payment_id, v_order.listing_id, v_order.seller_id,
    v_plan.id, v_plan.commercial_version, v_eligible_base,
    v_plan.sales_commission_bps, v_calc.standard_rate_base, v_calc.excess_rate_bps, v_calc.excess_base,
    v_calc.commission_amount, coalesce(v_payment.currency, 'ZAR'), 1, 'pending'
  )
  on conflict (payment_id) do nothing
  returning id into v_commission_id;

  if v_commission_id is null then
    select id into v_commission_id from public.unity_commissions where payment_id = p_payment_id;
    v_result := jsonb_build_object('qualified', false, 'reason', 'already_qualified', 'commission_id', v_commission_id);
    return v_result;
  end if;

  insert into public.unity_commission_history (
    commission_id, payment_id, previous_status, new_status, actor_type, actor_id, reason, calculation_snapshot, idempotency_key
  ) values (
    v_commission_id, p_payment_id, null, 'pending', 'system', null, 'sale payment captured',
    jsonb_build_object(
      'eligible_base', v_eligible_base, 'plan_id', v_plan.id, 'standard_rate_bps', v_plan.sales_commission_bps,
      'standard_rate_base', v_calc.standard_rate_base, 'excess_rate_bps', v_calc.excess_rate_bps, 'excess_base', v_calc.excess_base,
      'commission_amount', v_calc.commission_amount
    ),
    p_idempotency_key
  );

  v_result := jsonb_build_object('qualified', true, 'commission_id', v_commission_id, 'commission_amount', v_calc.commission_amount);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_order_id, 'qualify_sale_unity_commission', p_idempotency_key, v_request_hash, v_result)
    on conflict do nothing;
  end if;

  return v_result;
end;
$$;

-- ─────────────────────────────────────────
-- QUALIFY_RENTAL_PAYMENT_UNITY_COMMISSION -- trusted internal, called
-- from ensureRentalCharged() right after a rental_charge payment
-- reaches 'captured'. Event-based (keyed on payment_id, not booking_id)
-- so a future extension/recurring-payment feature needs zero further
-- Unity-commission-side changes -- today there is only ever one
-- rental_charge payment per booking, so this naturally produces exactly
-- one commission (Rule 3).
-- ─────────────────────────────────────────
create or replace function public.qualify_rental_payment_unity_commission(
  p_booking_id uuid,
  p_payment_id uuid,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking record;
  v_payment record;
  v_plan_id text;
  v_plan record;
  v_calc record;
  v_commission_id uuid;
  v_eligible_base numeric(12,2);
  v_request_hash text;
  v_idem record;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;

  v_request_hash := md5(coalesce(p_booking_id::text, '') || '|' || coalesce(p_payment_id::text, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_booking_id and operation = 'qualify_rental_payment_unity_commission' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select id into v_commission_id from public.unity_commissions where payment_id = p_payment_id;
  if v_commission_id is not null then
    v_result := jsonb_build_object('qualified', false, 'reason', 'already_qualified', 'commission_id', v_commission_id);
    if p_idempotency_key is not null then
      insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
      values (p_booking_id, 'qualify_rental_payment_unity_commission', p_idempotency_key, v_request_hash, v_result)
      on conflict do nothing;
    end if;
    return v_result;
  end if;

  select id, listing_id, renter_id, merchant_id into v_booking
  from public.bookings where id = p_booking_id;
  if v_booking.id is null then
    raise exception 'booking not found';
  end if;

  -- payment_type = 'rental_charge' only -- a 'deposit' payment (Rule 3's
  -- refundable-deposit exclusion) is never the payment being qualified,
  -- excluded structurally, not by a runtime amount check.
  select id, booking_id, payment_type, status, amount, currency into v_payment
  from public.payments where id = p_payment_id and booking_id = p_booking_id;
  if v_payment.id is null or v_payment.payment_type <> 'rental_charge' or v_payment.status not in ('captured', 'partially_captured') then
    v_result := jsonb_build_object('qualified', false, 'reason', 'payment_not_eligible');
    return v_result;
  end if;

  if exists (
    select 1 from public.disputes
    where booking_id = p_booking_id and status not in ('resolved', 'closed', 'cancelled')
  ) then
    v_result := jsonb_build_object('qualified', false, 'reason', 'unresolved_dispute');
    return v_result;
  end if;

  v_plan_id := public._get_effective_merchant_plan_id(v_booking.merchant_id);
  select id, rental_commission_bps, commercial_version into v_plan
  from public.merchant_subscription_plans where id = v_plan_id;
  if v_plan.id is null then
    raise exception 'merchant_subscription_plans is missing an entry for resolved plan id %', v_plan_id;
  end if;

  -- Rule 3/5: the rental_charge payment's own amount only -- deposit and
  -- replacement value are different fields/payment_types entirely,
  -- never touched here.
  v_eligible_base := v_payment.amount;

  select * into v_calc from public._calculate_unity_commission('rental', v_eligible_base, v_plan.rental_commission_bps);

  insert into public.unity_commissions (
    transaction_type, booking_id, payment_id, listing_id, merchant_id,
    merchant_plan_id, plan_commercial_version, eligible_base,
    standard_rate_bps, standard_rate_base, excess_rate_bps, excess_base,
    commission_amount, currency, calculation_version, status
  ) values (
    'rental', p_booking_id, p_payment_id, v_booking.listing_id, v_booking.merchant_id,
    v_plan.id, v_plan.commercial_version, v_eligible_base,
    v_plan.rental_commission_bps, v_calc.standard_rate_base, v_calc.excess_rate_bps, v_calc.excess_base,
    v_calc.commission_amount, coalesce(v_payment.currency, 'ZAR'), 1, 'pending'
  )
  on conflict (payment_id) do nothing
  returning id into v_commission_id;

  if v_commission_id is null then
    select id into v_commission_id from public.unity_commissions where payment_id = p_payment_id;
    v_result := jsonb_build_object('qualified', false, 'reason', 'already_qualified', 'commission_id', v_commission_id);
    return v_result;
  end if;

  -- Writes the platform_fee ledger entry that
  -- createMerchantPayout()'s existing sumBy('platform_fee') arithmetic
  -- already reads -- now plan-aware instead of the old flat 5%
  -- (20260823000004 removed the hardcoded insert from
  -- transition_payment_status()). Guarded by v_commission_id having just
  -- been genuinely created above (on conflict do nothing already
  -- returned early otherwise), so a qualification replay can never
  -- write a duplicate ledger entry.
  insert into public.ledger_entries (booking_id, payment_id, merchant_id, renter_id, amount, currency, entry_type, reference)
  values (p_booking_id, p_payment_id, v_booking.merchant_id, v_booking.renter_id, v_calc.commission_amount, coalesce(v_payment.currency, 'ZAR'), 'platform_fee', null);

  insert into public.unity_commission_history (
    commission_id, payment_id, previous_status, new_status, actor_type, actor_id, reason, calculation_snapshot, idempotency_key
  ) values (
    v_commission_id, p_payment_id, null, 'pending', 'system', null, 'rental payment captured',
    jsonb_build_object(
      'eligible_base', v_eligible_base, 'plan_id', v_plan.id, 'standard_rate_bps', v_plan.rental_commission_bps,
      'standard_rate_base', v_calc.standard_rate_base, 'excess_rate_bps', v_calc.excess_rate_bps, 'excess_base', v_calc.excess_base,
      'commission_amount', v_calc.commission_amount
    ),
    p_idempotency_key
  );

  v_result := jsonb_build_object('qualified', true, 'commission_id', v_commission_id, 'commission_amount', v_calc.commission_amount);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_booking_id, 'qualify_rental_payment_unity_commission', p_idempotency_key, v_request_hash, v_result)
    on conflict do nothing;
  end if;

  return v_result;
end;
$$;

-- ─────────────────────────────────────────
-- Grants -- service_role only, exactly matching every existing RPC file.
-- ─────────────────────────────────────────
revoke all on function public._calculate_unity_commission(text, numeric, integer) from public, anon, authenticated;
grant execute on function public._calculate_unity_commission(text, numeric, integer) to service_role;

revoke all on function public.qualify_sale_unity_commission(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.qualify_sale_unity_commission(uuid, uuid, text) to service_role;

revoke all on function public.qualify_rental_payment_unity_commission(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.qualify_rental_payment_unity_commission(uuid, uuid, text) to service_role;
