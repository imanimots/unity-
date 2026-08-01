-- ============================================================
-- Fix: payment idempotency scoping key violated a real FK constraint
-- ============================================================
-- Live-discovered bug: idempotency_keys.merchant_id has a hard foreign
-- key to profiles(id) (20260729000008). create_payment_intent,
-- transition_payment_status, and create_refund all scoped their
-- idempotency check by booking_id or payment_id -- neither is a
-- profiles.id -- so every idempotent call to these three functions
-- failed with a foreign-key violation before ever reaching its own
-- business logic. Confirmed live: the very first test call to
-- create_payment_intent failed this way.
--
-- Fix: each function now looks up the relevant row first and scopes its
-- idempotency check by that row's renter_id (a real profiles.id, always
-- populated on both bookings and payments). This is a reordering, not a
-- redesign -- the rest of each function's logic, including its request
-- hash formula (unchanged, so old-format hashes computed by
-- src/lib/payments/idempotency.ts before this fix still match), is
-- identical to 20260801000004.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

create or replace function public.create_payment_intent(
  p_booking_id uuid,
  p_payment_type payment_type,
  p_amount numeric,
  p_currency text default 'ZAR',
  p_provider text default 'mock',
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking record;
  v_request_hash text;
  v_idem record;
  v_payment_id uuid;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_amount is null or p_amount < 0 then
    raise exception 'invalid amount';
  end if;

  select id, renter_id, merchant_id into v_booking
  from public.bookings
  where id = p_booking_id;

  if v_booking.id is null then
    raise exception 'booking not found';
  end if;

  v_request_hash := md5(
    coalesce(p_booking_id::text, '') || '|' || coalesce(p_payment_type::text, '') || '|' ||
    coalesce(p_amount::text, '') || '|' || coalesce(p_currency, '') || '|' || coalesce(p_provider, '')
  );

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = v_booking.renter_id and operation = 'create_payment_intent' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  insert into public.payments (booking_id, renter_id, merchant_id, payment_type, status, amount, currency, provider, idempotency_key)
  values (p_booking_id, v_booking.renter_id, v_booking.merchant_id, p_payment_type, 'pending', p_amount, p_currency, p_provider, p_idempotency_key)
  returning id into v_payment_id;

  insert into public.payment_events (payment_id, actor_type, event_type, previous_status, new_status, idempotency_key)
  values (v_payment_id, 'system', 'payment_intent_created', null, 'pending', p_idempotency_key);

  v_result := jsonb_build_object('payment_id', v_payment_id, 'status', 'pending');

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (v_booking.renter_id, 'create_payment_intent', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

create or replace function public.transition_payment_status(
  p_payment_id uuid,
  p_new_status payment_status,
  p_provider_reference text default null,
  p_failure_reason text default null,
  p_actor_type text default 'system',
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment record;
  v_valid boolean;
  v_request_hash text;
  v_idem record;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_actor_type not in ('system', 'webhook', 'api') then
    raise exception 'invalid actor_type';
  end if;

  select id, status, amount, currency, payment_type, booking_id, merchant_id, renter_id
  into v_payment
  from public.payments
  where id = p_payment_id
  for update;

  if v_payment.id is null then
    raise exception 'payment not found';
  end if;

  v_request_hash := md5(
    coalesce(p_payment_id::text, '') || '|' || coalesce(p_new_status::text, '') || '|' ||
    coalesce(p_provider_reference, '') || '|' || coalesce(p_failure_reason, '')
  );

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = v_payment.renter_id and operation = 'transition_payment_status' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  v_valid := case v_payment.status
    when 'pending' then p_new_status in ('authorised', 'captured', 'failed', 'cancelled', 'expired')
    when 'authorised' then p_new_status in ('captured', 'partially_captured', 'released', 'cancelled', 'expired')
    when 'captured' then p_new_status in ('refunded', 'partially_refunded', 'chargeback')
    when 'partially_captured' then p_new_status in ('captured', 'refunded', 'partially_refunded', 'chargeback')
    when 'partially_refunded' then p_new_status in ('refunded', 'chargeback')
    else false
  end;

  if not v_valid then
    raise exception 'invalid payment status transition from % to %', v_payment.status, p_new_status;
  end if;

  update public.payments set
    status = p_new_status,
    provider_reference = coalesce(p_provider_reference, provider_reference),
    failure_reason = case when p_new_status = 'failed' then p_failure_reason else failure_reason end,
    authorised_at = case when p_new_status = 'authorised' then now() else authorised_at end,
    captured_at = case when p_new_status in ('captured', 'partially_captured') then now() else captured_at end,
    released_at = case when p_new_status = 'released' then now() else released_at end,
    refunded_at = case when p_new_status in ('refunded', 'partially_refunded') then now() else refunded_at end,
    cancelled_at = case when p_new_status = 'cancelled' then now() else cancelled_at end,
    expired_at = case when p_new_status = 'expired' then now() else expired_at end,
    version = version + 1
  where id = p_payment_id;

  insert into public.payment_events (payment_id, actor_type, event_type, previous_status, new_status, metadata, idempotency_key)
  values (p_payment_id, p_actor_type, 'status_transition', v_payment.status, p_new_status, jsonb_build_object('provider_reference', p_provider_reference), p_idempotency_key);

  if p_new_status = 'captured' and v_payment.payment_type = 'rental_charge' then
    insert into public.ledger_entries (booking_id, payment_id, merchant_id, renter_id, amount, currency, entry_type, reference)
    values (v_payment.booking_id, p_payment_id, v_payment.merchant_id, v_payment.renter_id, v_payment.amount, v_payment.currency, 'rental_charge', p_provider_reference);

    insert into public.ledger_entries (booking_id, payment_id, merchant_id, renter_id, amount, currency, entry_type, reference)
    values (v_payment.booking_id, p_payment_id, v_payment.merchant_id, v_payment.renter_id, round(v_payment.amount * 0.05, 2), v_payment.currency, 'platform_fee', p_provider_reference);
  elsif p_new_status = 'authorised' and v_payment.payment_type = 'deposit' then
    insert into public.ledger_entries (booking_id, payment_id, merchant_id, renter_id, amount, currency, entry_type, reference)
    values (v_payment.booking_id, p_payment_id, v_payment.merchant_id, v_payment.renter_id, v_payment.amount, v_payment.currency, 'deposit_hold', p_provider_reference);
  elsif p_new_status = 'released' and v_payment.payment_type = 'deposit' then
    insert into public.ledger_entries (booking_id, payment_id, merchant_id, renter_id, amount, currency, entry_type, reference)
    values (v_payment.booking_id, p_payment_id, v_payment.merchant_id, v_payment.renter_id, v_payment.amount, v_payment.currency, 'deposit_release', p_provider_reference);
  elsif p_new_status in ('captured', 'partially_captured') and v_payment.payment_type = 'deposit' then
    insert into public.ledger_entries (booking_id, payment_id, merchant_id, renter_id, amount, currency, entry_type, reference)
    values (v_payment.booking_id, p_payment_id, v_payment.merchant_id, v_payment.renter_id, v_payment.amount, v_payment.currency, 'deposit_capture', p_provider_reference);
  end if;

  v_result := jsonb_build_object('payment_id', p_payment_id, 'status', p_new_status);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (v_payment.renter_id, 'transition_payment_status', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

create or replace function public.create_refund(
  p_payment_id uuid,
  p_amount numeric,
  p_reason text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment record;
  v_already_refunded numeric(12,2);
  v_request_hash text;
  v_idem record;
  v_refund_id uuid;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'invalid refund amount';
  end if;

  select id, amount, status, renter_id into v_payment from public.payments where id = p_payment_id for update;
  if v_payment.id is null then
    raise exception 'payment not found';
  end if;

  v_request_hash := md5(coalesce(p_payment_id::text, '') || '|' || coalesce(p_amount::text, '') || '|' || coalesce(p_reason, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = v_payment.renter_id and operation = 'create_refund' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  if v_payment.status not in ('captured', 'partially_captured', 'partially_refunded') then
    raise exception 'payment is not in a refundable status';
  end if;

  select coalesce(sum(amount), 0) into v_already_refunded
  from public.refunds
  where payment_id = p_payment_id and status <> 'failed';

  if v_already_refunded + p_amount > v_payment.amount then
    raise exception 'refund amount exceeds the amount available to refund';
  end if;

  insert into public.refunds (payment_id, amount, reason, status, idempotency_key)
  values (p_payment_id, p_amount, p_reason, 'pending', p_idempotency_key)
  returning id into v_refund_id;

  v_result := jsonb_build_object('refund_id', v_refund_id, 'status', 'pending');

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (v_payment.renter_id, 'create_refund', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

-- create or replace preserves existing grants (service_role only) --
-- reconfirmed empirically after applying, not assumed.
