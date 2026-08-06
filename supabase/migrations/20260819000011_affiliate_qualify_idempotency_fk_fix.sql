-- ============================================================
-- Step 11 Phase 7 -- fix a live bug found during regression testing:
-- qualify_sale_affiliate_commission / qualify_rental_payment_affiliate_
-- commission both wrote p_order_id / p_booking_id into
-- idempotency_keys.merchant_id, which has a hard FK to profiles(id).
-- An order/booking id is never a profile id, so every qualifying call
-- with a non-null idempotency key raised
-- "insert or update on table idempotency_keys violates foreign key
-- constraint idempotency_keys_merchant_id_fkey" -- and because this is
-- one PL/pgSQL function execution (one transaction), the failure rolled
-- back the commission row and its history row that had already been
-- inserted earlier in the SAME call. Net effect: every successful sale/
-- rental payment silently produced zero commissions (the orchestrator's
-- best-effort try/catch swallowed the error, matching its own contract
-- of never blocking the underlying payment -- but it also meant nothing
-- surfaced the failure until this regression run).
--
-- Fix: fetch the order/booking record (and therefore its real
-- seller_id/merchant_id, a genuine profiles.id) BEFORE the idempotency
-- cache lookup, and use that real profile id for merchant_id everywhere
-- in this function instead of the order/booking id. No business logic
-- changes; the order/booking existence check simply now runs slightly
-- earlier than the idempotency-replay check, which is strictly more
-- correct (a forged/nonexistent order id can no longer appear to
-- produce a cached-looking response).
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

create or replace function public.qualify_sale_affiliate_commission(
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
  v_listing record;
  v_attribution record;
  v_commission_id uuid;
  v_eligible_base numeric(12,2);
  v_commission_amount numeric(12,2);
  v_request_hash text;
  v_idem record;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;

  select id, listing_id, buyer_id, seller_id, total_amount, shipping_fee, status into v_order
  from public.orders where id = p_order_id;
  if v_order.id is null then
    raise exception 'order not found';
  end if;

  v_request_hash := md5(coalesce(p_order_id::text, '') || '|' || coalesce(p_payment_id::text, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = v_order.seller_id and operation = 'qualify_sale_affiliate_commission' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  -- Idempotent by construction regardless of the check above --
  -- affiliate_commissions.payment_id is unique at the database level.
  select id, status into v_commission_id from public.affiliate_commissions where payment_id = p_payment_id;
  if v_commission_id is not null then
    v_result := jsonb_build_object('qualified', false, 'reason', 'already_qualified', 'commission_id', v_commission_id);
    if p_idempotency_key is not null then
      insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
      values (v_order.seller_id, 'qualify_sale_affiliate_commission', p_idempotency_key, v_request_hash, v_result)
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

  select id, accepts_affiliates, affiliate_commission_rate into v_listing
  from public.listings where id = v_order.listing_id;
  if v_listing.id is null or not v_listing.accepts_affiliates then
    v_result := jsonb_build_object('qualified', false, 'reason', 'listing_not_affiliate_enabled');
    return v_result;
  end if;

  select id, affiliate_id, status, consumed_at into v_attribution
  from public.affiliate_attributions
  where referred_user_id = v_order.buyer_id and listing_id = v_order.listing_id and status in ('active', 'consumed');
  if v_attribution.id is null then
    v_result := jsonb_build_object('qualified', false, 'reason', 'no_attribution');
    return v_result;
  end if;

  -- Unresolved dispute freezes qualification (does not void it).
  if exists (
    select 1 from public.disputes
    where order_id = p_order_id and status not in ('resolved', 'closed', 'cancelled')
  ) then
    v_result := jsonb_build_object('qualified', false, 'reason', 'unresolved_dispute');
    return v_result;
  end if;

  v_eligible_base := greatest(v_order.total_amount - coalesce(v_order.shipping_fee, 0), 0);
  v_commission_amount := round(v_eligible_base * v_listing.affiliate_commission_rate / 100, 2);

  insert into public.affiliate_commissions (
    attribution_id, transaction_type, order_id, payment_id, listing_id, merchant_id,
    affiliate_id, referred_user_id, eligible_base, commission_rate, commission_amount,
    currency, calculation_version, status
  ) values (
    v_attribution.id, 'sale', p_order_id, p_payment_id, v_order.listing_id, v_order.seller_id,
    v_attribution.affiliate_id, v_order.buyer_id, v_eligible_base, v_listing.affiliate_commission_rate, v_commission_amount,
    coalesce(v_payment.currency, 'ZAR'), 1, 'pending'
  )
  on conflict (payment_id) do nothing
  returning id into v_commission_id;

  if v_commission_id is null then
    select id into v_commission_id from public.affiliate_commissions where payment_id = p_payment_id;
    v_result := jsonb_build_object('qualified', false, 'reason', 'already_qualified', 'commission_id', v_commission_id);
    return v_result;
  end if;

  if v_attribution.consumed_at is null then
    update public.affiliate_attributions set consumed_at = now(), status = 'consumed' where id = v_attribution.id;
  end if;

  insert into public.affiliate_commission_history (
    commission_id, attribution_id, listing_id, payment_id, previous_status, new_status,
    actor_type, actor_id, reason, calculation_snapshot, idempotency_key
  ) values (
    v_commission_id, v_attribution.id, v_order.listing_id, p_payment_id, null, 'pending',
    'system', null, 'sale payment captured',
    jsonb_build_object('eligible_base', v_eligible_base, 'rate', v_listing.affiliate_commission_rate, 'amount', v_commission_amount),
    p_idempotency_key
  );

  v_result := jsonb_build_object('qualified', true, 'commission_id', v_commission_id, 'commission_amount', v_commission_amount);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (v_order.seller_id, 'qualify_sale_affiliate_commission', p_idempotency_key, v_request_hash, v_result)
    on conflict do nothing;
  end if;

  return v_result;
end;
$$;

create or replace function public.qualify_rental_payment_affiliate_commission(
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
  v_listing record;
  v_attribution record;
  v_commission_id uuid;
  v_eligible_base numeric(12,2);
  v_commission_amount numeric(12,2);
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
    where merchant_id = v_booking.merchant_id and operation = 'qualify_rental_payment_affiliate_commission' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select id, status into v_commission_id from public.affiliate_commissions where payment_id = p_payment_id;
  if v_commission_id is not null then
    v_result := jsonb_build_object('qualified', false, 'reason', 'already_qualified', 'commission_id', v_commission_id);
    if p_idempotency_key is not null then
      insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
      values (v_booking.merchant_id, 'qualify_rental_payment_affiliate_commission', p_idempotency_key, v_request_hash, v_result)
      on conflict do nothing;
    end if;
    return v_result;
  end if;

  -- payment_type = 'rental_charge' only -- a 'deposit' payment is never
  -- the payment being qualified, excluded structurally, not by a
  -- runtime amount check.
  select id, booking_id, payment_type, status, amount, currency into v_payment
  from public.payments where id = p_payment_id and booking_id = p_booking_id;
  if v_payment.id is null or v_payment.payment_type <> 'rental_charge' or v_payment.status not in ('captured', 'partially_captured') then
    v_result := jsonb_build_object('qualified', false, 'reason', 'payment_not_eligible');
    return v_result;
  end if;

  select id, accepts_affiliates, affiliate_commission_rate into v_listing
  from public.listings where id = v_booking.listing_id;
  if v_listing.id is null or not v_listing.accepts_affiliates then
    v_result := jsonb_build_object('qualified', false, 'reason', 'listing_not_affiliate_enabled');
    return v_result;
  end if;

  select id, affiliate_id, status, consumed_at into v_attribution
  from public.affiliate_attributions
  where referred_user_id = v_booking.renter_id and listing_id = v_booking.listing_id and status in ('active', 'consumed');
  if v_attribution.id is null then
    v_result := jsonb_build_object('qualified', false, 'reason', 'no_attribution');
    return v_result;
  end if;

  if exists (
    select 1 from public.disputes
    where booking_id = p_booking_id and status not in ('resolved', 'closed', 'cancelled')
  ) then
    v_result := jsonb_build_object('qualified', false, 'reason', 'unresolved_dispute');
    return v_result;
  end if;

  v_eligible_base := v_payment.amount;
  v_commission_amount := round(v_eligible_base * v_listing.affiliate_commission_rate / 100, 2);

  insert into public.affiliate_commissions (
    attribution_id, transaction_type, booking_id, payment_id, listing_id, merchant_id,
    affiliate_id, referred_user_id, eligible_base, commission_rate, commission_amount,
    currency, calculation_version, status
  ) values (
    v_attribution.id, 'rental', p_booking_id, p_payment_id, v_booking.listing_id, v_booking.merchant_id,
    v_attribution.affiliate_id, v_booking.renter_id, v_eligible_base, v_listing.affiliate_commission_rate, v_commission_amount,
    coalesce(v_payment.currency, 'ZAR'), 1, 'pending'
  )
  on conflict (payment_id) do nothing
  returning id into v_commission_id;

  if v_commission_id is null then
    select id into v_commission_id from public.affiliate_commissions where payment_id = p_payment_id;
    v_result := jsonb_build_object('qualified', false, 'reason', 'already_qualified', 'commission_id', v_commission_id);
    return v_result;
  end if;

  if v_attribution.consumed_at is null then
    update public.affiliate_attributions set consumed_at = now(), status = 'consumed' where id = v_attribution.id;
  end if;

  insert into public.affiliate_commission_history (
    commission_id, attribution_id, listing_id, payment_id, previous_status, new_status,
    actor_type, actor_id, reason, calculation_snapshot, idempotency_key
  ) values (
    v_commission_id, v_attribution.id, v_booking.listing_id, p_payment_id, null, 'pending',
    'system', null, 'rental payment captured',
    jsonb_build_object('eligible_base', v_eligible_base, 'rate', v_listing.affiliate_commission_rate, 'amount', v_commission_amount),
    p_idempotency_key
  );

  v_result := jsonb_build_object('qualified', true, 'commission_id', v_commission_id, 'commission_amount', v_commission_amount);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (v_booking.merchant_id, 'qualify_rental_payment_affiliate_commission', p_idempotency_key, v_request_hash, v_result)
    on conflict do nothing;
  end if;

  return v_result;
end;
$$;

revoke all on function public.qualify_sale_affiliate_commission(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.qualify_sale_affiliate_commission(uuid, uuid, text) to service_role;
revoke all on function public.qualify_rental_payment_affiliate_commission(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.qualify_rental_payment_affiliate_commission(uuid, uuid, text) to service_role;
