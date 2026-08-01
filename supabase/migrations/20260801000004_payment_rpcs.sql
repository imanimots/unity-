-- ============================================================
-- Payment domain RPCs (Phase 2C)
-- ============================================================
-- All functions are service_role-only (grants at the end of this file),
-- the same trust boundary already proven for bookings and listings. No
-- client may set payment status, alter amounts, or mark anything
-- successful -- amounts and identities are always derived server-side
-- from the booking or passed explicitly by the trusted Next.js route
-- calling with the service-role client, never taken from client input.
--
-- Idempotency reuses idempotency_keys exactly as-is (Phase 2A). Its
-- primary-key column is named merchant_id but is used as a generic
-- scoping key throughout this codebase already (Phase 2B repurposed it
-- as "acting user id"). Here, several of these operations have no
-- natural acting user (a webhook-driven capture has no human caller), so
-- the scoping key is whichever id makes the request logically unique:
-- booking_id for intent creation, payment_id for transitions/attempts/
-- refunds, merchant_id for payouts. Documented per function below.
--
-- No real money moves anywhere in this file.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

-- ------------------------------------------------------------
-- CREATE_PAYMENT_INTENT -- scoped by booking_id.
-- ------------------------------------------------------------
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

  v_request_hash := md5(
    coalesce(p_booking_id::text, '') || '|' || coalesce(p_payment_type::text, '') || '|' ||
    coalesce(p_amount::text, '') || '|' || coalesce(p_currency, '') || '|' || coalesce(p_provider, '')
  );

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_booking_id and operation = 'create_payment_intent' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select id, renter_id, merchant_id into v_booking
  from public.bookings
  where id = p_booking_id;

  if v_booking.id is null then
    raise exception 'booking not found';
  end if;

  insert into public.payments (booking_id, renter_id, merchant_id, payment_type, status, amount, currency, provider, idempotency_key)
  values (p_booking_id, v_booking.renter_id, v_booking.merchant_id, p_payment_type, 'pending', p_amount, p_currency, p_provider, p_idempotency_key)
  returning id into v_payment_id;

  insert into public.payment_events (payment_id, actor_type, event_type, previous_status, new_status, idempotency_key)
  values (v_payment_id, 'system', 'payment_intent_created', null, 'pending', p_idempotency_key);

  v_result := jsonb_build_object('payment_id', v_payment_id, 'status', 'pending');

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_booking_id, 'create_payment_intent', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

-- ------------------------------------------------------------
-- TRANSITION_PAYMENT_STATUS -- scoped by payment_id. The core state
-- machine enforcement point; every allowed transition is listed
-- explicitly, nothing falls through silently. Records a ledger entry for
-- transitions that represent real financial movement.
-- ------------------------------------------------------------
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

  v_request_hash := md5(
    coalesce(p_payment_id::text, '') || '|' || coalesce(p_new_status::text, '') || '|' ||
    coalesce(p_provider_reference, '') || '|' || coalesce(p_failure_reason, '')
  );

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_payment_id and operation = 'transition_payment_status' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select id, status, amount, currency, payment_type, booking_id, merchant_id, renter_id
  into v_payment
  from public.payments
  where id = p_payment_id
  for update;

  if v_payment.id is null then
    raise exception 'payment not found';
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

  -- Ledger entries for transitions representing real financial movement.
  -- Platform fee (5%) mirrors the rate already documented in
  -- src/app/(dashboard)/dashboard/merchant/payouts/page.tsx -- no real
  -- money moves, this only records what would move.
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
    values (p_payment_id, 'transition_payment_status', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

-- ------------------------------------------------------------
-- RECORD_PAYMENT_ATTEMPT -- scoped by payment_id. Not idempotency-keyed
-- like the others -- attempt_number plus the table's own unique
-- constraint (payment_id, attempt_number) is the natural dedup key here.
-- ------------------------------------------------------------
create or replace function public.record_payment_attempt(
  p_payment_id uuid,
  p_attempt_number int,
  p_provider text,
  p_status text,
  p_provider_reference text default null,
  p_failure_code text default null,
  p_failure_message text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if not exists (select 1 from public.payments where id = p_payment_id) then
    raise exception 'payment not found';
  end if;

  insert into public.payment_attempts (payment_id, attempt_number, provider, status, provider_reference, failure_code, failure_message)
  values (p_payment_id, p_attempt_number, p_provider, p_status, p_provider_reference, p_failure_code, p_failure_message)
  on conflict (payment_id, attempt_number) do update
    set status = excluded.status,
        provider_reference = excluded.provider_reference,
        failure_code = excluded.failure_code,
        failure_message = excluded.failure_message
  returning id into v_attempt_id;

  return jsonb_build_object('attempt_id', v_attempt_id, 'status', p_status);
end;
$$;

-- ------------------------------------------------------------
-- CREATE_REFUND -- scoped by payment_id. Refund amount may not exceed
-- the payment's own captured amount minus any prior refunds already
-- recorded -- a real refund-calculation guard, not just a shape check.
-- ------------------------------------------------------------
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

  v_request_hash := md5(coalesce(p_payment_id::text, '') || '|' || coalesce(p_amount::text, '') || '|' || coalesce(p_reason, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_payment_id and operation = 'create_refund' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select id, amount, status into v_payment from public.payments where id = p_payment_id for update;
  if v_payment.id is null then
    raise exception 'payment not found';
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
    values (p_payment_id, 'create_refund', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

-- ------------------------------------------------------------
-- CREATE_MERCHANT_PAYOUT -- scoped by merchant_id, the one operation
-- here with a genuine "acting" identity in the ordinary sense.
-- ------------------------------------------------------------
create or replace function public.create_merchant_payout(
  p_merchant_id uuid,
  p_booking_id uuid,
  p_amount numeric,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request_hash text;
  v_idem record;
  v_payout_id uuid;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'invalid payout amount';
  end if;

  v_request_hash := md5(coalesce(p_merchant_id::text, '') || '|' || coalesce(p_booking_id::text, '') || '|' || coalesce(p_amount::text, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_merchant_id and operation = 'create_merchant_payout' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  insert into public.merchant_payouts (merchant_id, booking_id, amount, status, idempotency_key)
  values (p_merchant_id, p_booking_id, p_amount, 'pending', p_idempotency_key)
  returning id into v_payout_id;

  insert into public.ledger_entries (booking_id, payout_id, merchant_id, amount, currency, entry_type, reference)
  values (p_booking_id, v_payout_id, p_merchant_id, p_amount, 'ZAR', 'merchant_payout', null);

  v_result := jsonb_build_object('payout_id', v_payout_id, 'status', 'pending');

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_merchant_id, 'create_merchant_payout', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

-- ------------------------------------------------------------
-- RECORD_WEBHOOK_EVENT -- dedup via payment_webhook_events' own unique
-- constraint (provider, provider_event_id), not idempotency_keys. Every
-- real payment provider's webhook carries its own event id for exactly
-- this purpose. Returns is_duplicate so the caller can safely no-op.
-- ------------------------------------------------------------
create or replace function public.record_webhook_event(
  p_provider text,
  p_provider_event_id text,
  p_signature_valid boolean,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_is_duplicate boolean := false;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;

  begin
    insert into public.payment_webhook_events (provider, provider_event_id, signature_valid, payload)
    values (p_provider, p_provider_event_id, p_signature_valid, p_payload)
    returning id into v_id;
  exception when unique_violation then
    v_is_duplicate := true;
    select id into v_id from public.payment_webhook_events
    where provider = p_provider and provider_event_id = p_provider_event_id;
  end;

  return jsonb_build_object('webhook_event_id', v_id, 'is_duplicate', v_is_duplicate);
end;
$$;

-- ------------------------------------------------------------
-- GRANTS -- service_role only, matching every other RPC in this schema.
-- ------------------------------------------------------------
revoke all on function public.create_payment_intent(uuid, payment_type, numeric, text, text, text) from public, anon, authenticated;
revoke all on function public.transition_payment_status(uuid, payment_status, text, text, text, text) from public, anon, authenticated;
revoke all on function public.record_payment_attempt(uuid, int, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.create_refund(uuid, numeric, text, text) from public, anon, authenticated;
revoke all on function public.create_merchant_payout(uuid, uuid, numeric, text) from public, anon, authenticated;
revoke all on function public.record_webhook_event(text, text, boolean, jsonb) from public, anon, authenticated;

grant execute on function public.create_payment_intent(uuid, payment_type, numeric, text, text, text) to service_role;
grant execute on function public.transition_payment_status(uuid, payment_status, text, text, text, text) to service_role;
grant execute on function public.record_payment_attempt(uuid, int, text, text, text, text, text) to service_role;
grant execute on function public.create_refund(uuid, numeric, text, text) to service_role;
grant execute on function public.create_merchant_payout(uuid, uuid, numeric, text) to service_role;
grant execute on function public.record_webhook_event(text, text, boolean, jsonb) to service_role;
