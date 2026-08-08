-- ============================================================
-- Unity Phase 2 -- Commission Framework
-- Removes the hardcoded flat-5% platform_fee ledger write from
-- transition_payment_status() -- this was the one confirmed instance of
-- Unity commission logic living inside a generic, unrelated payment
-- state-machine RPC (Phase 2 Step A finding: byte-identical to the flat
-- rate in src/lib/payments/calculations.ts's calculatePlatformFee(),
-- confirmed live via
-- `round(v_payment.amount * 0.05, 2)` in the original 20260801000004
-- migration).
--
-- The platform_fee ledger entry now comes from
-- qualify_rental_payment_unity_commission() instead (this same
-- migration set) -- plan-aware, keyed off the merchant's actual
-- effective plan rather than a flat rate, and written atomically with
-- the unity_commissions snapshot row. This is a deliberate separation
-- of concerns: transition_payment_status() stays a generic payment
-- state machine with zero knowledge of the subscription/commission
-- domain, exactly like every other payment-status transition it already
-- handles (deposit hold/release/capture).
--
-- createMerchantPayout()'s existing `sumBy('platform_fee')` arithmetic
-- is UNCHANGED by this migration -- it will simply read whatever amount
-- the new qualification RPC wrote instead of the old flat 5%, with zero
-- changes needed to that TS file for this specific piece (see Phase 2
-- Step F for the separate affiliate-reward-subtraction change, which
-- IS a real change to that file).
--
-- Everything else in this function is byte-identical to the version in
-- 20260801000004_payment_rpcs.sql -- only the two-line platform_fee
-- insert (and its header comment) is removed.
-- ============================================================

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
  -- Unity Phase 2: the flat-5% platform_fee insert previously here has
  -- been removed -- qualify_rental_payment_unity_commission() now owns
  -- writing that ledger entry, plan-aware, atomically with the
  -- unity_commissions snapshot. No real money moves in either case,
  -- this only records what would move.
  if p_new_status = 'captured' and v_payment.payment_type = 'rental_charge' then
    insert into public.ledger_entries (booking_id, payment_id, merchant_id, renter_id, amount, currency, entry_type, reference)
    values (v_payment.booking_id, p_payment_id, v_payment.merchant_id, v_payment.renter_id, v_payment.amount, v_payment.currency, 'rental_charge', p_provider_reference);
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
