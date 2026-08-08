-- ============================================================
-- Unity Phase 2 -- fix a live bug found during regression testing,
-- identical in shape to the one already fixed for affiliate commissions
-- in 20260819000011_affiliate_qualify_idempotency_fk_fix.sql:
--
-- qualify_sale_unity_commission / qualify_rental_payment_unity_commission
-- both wrote p_order_id / p_booking_id into idempotency_keys.merchant_id,
-- which has a hard FK to profiles(id). An order/booking id is never a
-- profile id, so every qualifying call with a non-null idempotency key
-- raised "insert or update on table idempotency_keys violates foreign
-- key constraint idempotency_keys_merchant_id_fkey" -- and because this
-- is one PL/pgSQL function execution (one transaction), the failure
-- rolled back the commission row, the platform_fee ledger entry, and
-- the history row that had already been inserted earlier in the SAME
-- call. Net effect: every successful rental/sale payment silently
-- produced zero Unity commissions -- the orchestrator's best-effort
-- try/catch swallowed the error, matching its own contract of never
-- blocking the underlying payment, but it also meant nothing surfaced
-- the failure until this regression run.
--
-- Fix: use the transaction's real merchant profile id
-- (v_order.seller_id / v_booking.merchant_id) for idempotency_keys.merchant_id
-- everywhere in both functions instead of the order/booking id. No
-- business logic changes -- same exclusions, same plan resolution, same
-- calculation, same ledger write.
-- ============================================================

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

  select id, listing_id, seller_id, total_amount, shipping_fee, status into v_order
  from public.orders where id = p_order_id;
  if v_order.id is null then
    raise exception 'order not found';
  end if;

  v_request_hash := md5(coalesce(p_order_id::text, '') || '|' || coalesce(p_payment_id::text, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = v_order.seller_id and operation = 'qualify_sale_unity_commission' and idempotency_key = p_idempotency_key;

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
      values (v_order.seller_id, 'qualify_sale_unity_commission', p_idempotency_key, v_request_hash, v_result)
      on conflict do nothing;
    end if;
    return v_result;
  end if;

  select id, order_id, payment_type, status, amount, currency into v_payment
  from public.payments where id = p_payment_id and order_id = p_order_id;
  if v_payment.id is null or v_payment.payment_type <> 'order_payment' or v_payment.status <> 'captured' then
    v_result := jsonb_build_object('qualified', false, 'reason', 'payment_not_eligible');
    return v_result;
  end if;

  if exists (
    select 1 from public.disputes
    where order_id = p_order_id and status not in ('resolved', 'closed', 'cancelled')
  ) then
    v_result := jsonb_build_object('qualified', false, 'reason', 'unresolved_dispute');
    return v_result;
  end if;

  v_plan_id := public._get_effective_merchant_plan_id(v_order.seller_id);
  select id, sales_commission_bps, commercial_version into v_plan
  from public.merchant_subscription_plans where id = v_plan_id;
  if v_plan.id is null then
    raise exception 'merchant_subscription_plans is missing an entry for resolved plan id %', v_plan_id;
  end if;

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
    values (v_order.seller_id, 'qualify_sale_unity_commission', p_idempotency_key, v_request_hash, v_result)
    on conflict do nothing;
  end if;

  return v_result;
end;
$$;

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

  select id, listing_id, renter_id, merchant_id into v_booking
  from public.bookings where id = p_booking_id;
  if v_booking.id is null then
    raise exception 'booking not found';
  end if;

  v_request_hash := md5(coalesce(p_booking_id::text, '') || '|' || coalesce(p_payment_id::text, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = v_booking.merchant_id and operation = 'qualify_rental_payment_unity_commission' and idempotency_key = p_idempotency_key;

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
      values (v_booking.merchant_id, 'qualify_rental_payment_unity_commission', p_idempotency_key, v_request_hash, v_result)
      on conflict do nothing;
    end if;
    return v_result;
  end if;

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
    values (v_booking.merchant_id, 'qualify_rental_payment_unity_commission', p_idempotency_key, v_request_hash, v_result)
    on conflict do nothing;
  end if;

  return v_result;
end;
$$;

revoke all on function public.qualify_sale_unity_commission(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.qualify_sale_unity_commission(uuid, uuid, text) to service_role;
revoke all on function public.qualify_rental_payment_unity_commission(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.qualify_rental_payment_unity_commission(uuid, uuid, text) to service_role;
