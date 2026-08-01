-- ============================================================
-- CAPTURE_DEPOSIT_AMOUNT -- narrowly scoped new RPC (orchestrator pass)
-- ============================================================
-- Gap found while building the capture-deposit orchestrator workflow:
-- transition_payment_status() (20260801000004) always ledger-records a
-- deposit capture using the payment's full `amount`, regardless of the
-- actual amount captured in that transition -- correct for the only
-- scenario Phase 2C tested (a full capture), wrong for a genuine partial
-- capture, where the financial truth is "captured R150 of a R500
-- deposit," not "R500 was captured."
--
-- transition_payment_status() itself is left untouched -- its rental-
-- charge, deposit-authorize, and deposit-release paths are unaffected
-- and already live-verified. This is a new, additive RPC specifically
-- for the one case the existing one cannot safely express: a capture
-- amount that differs from the payment's total.
--
-- Already-captured total is derived from ledger_entries
-- (entry_type='deposit_capture' for this payment), not from a running
-- counter column -- the ledger is already the source of truth for "how
-- much has moved" and this avoids a second, potentially-drifting copy of
-- the same fact.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

create or replace function public.capture_deposit_amount(
  p_payment_id uuid,
  p_amount numeric,
  p_provider_reference text default null,
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
  v_already_captured numeric(12,2);
  v_remaining numeric(12,2);
  v_new_status payment_status;
  v_request_hash text;
  v_idem record;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'invalid capture amount';
  end if;

  select id, booking_id, merchant_id, renter_id, amount, currency, status, payment_type
  into v_payment
  from public.payments
  where id = p_payment_id
  for update;

  if v_payment.id is null then
    raise exception 'payment not found';
  end if;
  if v_payment.payment_type <> 'deposit' then
    raise exception 'capture_deposit_amount only applies to deposit payments';
  end if;

  v_request_hash := md5(coalesce(p_payment_id::text, '') || '|' || coalesce(p_amount::text, '') || '|' || coalesce(p_reason, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = v_payment.renter_id and operation = 'capture_deposit_amount' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  if v_payment.status not in ('authorised', 'partially_captured') then
    raise exception 'deposit payment is "%", not eligible for capture', v_payment.status;
  end if;

  select coalesce(sum(amount), 0) into v_already_captured
  from public.ledger_entries
  where payment_id = p_payment_id and entry_type = 'deposit_capture';

  v_remaining := v_payment.amount - v_already_captured;

  if p_amount > v_remaining then
    raise exception 'capture amount exceeds the remaining authorized deposit amount';
  end if;

  v_new_status := case when p_amount = v_remaining then 'captured' else 'partially_captured' end;

  update public.payments set
    status = v_new_status,
    provider_reference = coalesce(p_provider_reference, provider_reference),
    captured_at = now(),
    version = version + 1
  where id = p_payment_id;

  insert into public.payment_events (payment_id, actor_type, event_type, previous_status, new_status, metadata, idempotency_key)
  values (p_payment_id, 'system', 'deposit_captured', v_payment.status, v_new_status, jsonb_build_object('amount', p_amount, 'reason', p_reason), p_idempotency_key);

  insert into public.ledger_entries (booking_id, payment_id, merchant_id, renter_id, amount, currency, entry_type, reference)
  values (v_payment.booking_id, p_payment_id, v_payment.merchant_id, v_payment.renter_id, p_amount, v_payment.currency, 'deposit_capture', p_provider_reference);

  v_result := jsonb_build_object('payment_id', p_payment_id, 'status', v_new_status, 'captured_amount', p_amount, 'remaining_amount', v_remaining - p_amount);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (v_payment.renter_id, 'capture_deposit_amount', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

revoke all on function public.capture_deposit_amount(uuid, numeric, text, text, text) from public, anon, authenticated;
grant execute on function public.capture_deposit_amount(uuid, numeric, text, text, text) to service_role;
