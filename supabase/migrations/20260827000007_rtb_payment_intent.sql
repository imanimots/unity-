-- ============================================================
-- Phase 5 -- Rent-to-Buy: payment intent creation RPC.
-- ============================================================
-- Fix-forward addition -- the RPC migration (20260827000005) built
-- every RTB lifecycle RPC but omitted the payment-intent creation step
-- the orchestrator layer needs before it can ever call a provider.
-- Mirrors create_order_payment_intent()/create_barter_payment_intent()
-- exactly: a plain insert, no provider call, amount always supplied by
-- the caller (the orchestrator reads it from the agreement/installment
-- row server-side, never from a client). renter_id/merchant_id are
-- repurposed as customer/merchant, the same repurposing precedent every
-- other domain in this codebase already uses.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

create or replace function public.create_rent_to_buy_payment_intent(
  p_rent_to_buy_agreement_id uuid,
  p_payer_id uuid,
  p_counterparty_id uuid,
  p_payment_type text,
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
  v_request_hash text;
  v_idem record;
  v_payment_id uuid;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_payment_type not in ('rent_to_buy_installment', 'rent_to_buy_deposit') then
    raise exception 'invalid payment type for a rent-to-buy payment intent';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'invalid amount';
  end if;

  v_request_hash := md5(
    coalesce(p_rent_to_buy_agreement_id::text, '') || '|' || coalesce(p_payment_type, '') || '|' ||
    coalesce(p_amount::text, '') || '|' || coalesce(p_currency, '') || '|' || coalesce(p_provider, '')
  );

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_payer_id and operation = 'create_rent_to_buy_payment_intent' and idempotency_key = p_idempotency_key;
    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  insert into public.payments (rent_to_buy_agreement_id, renter_id, merchant_id, payment_type, status, amount, currency, provider, idempotency_key)
  values (p_rent_to_buy_agreement_id, p_payer_id, p_counterparty_id, p_payment_type::payment_type, 'pending', p_amount, coalesce(p_currency, 'ZAR'), coalesce(p_provider, 'mock'), p_idempotency_key)
  returning id into v_payment_id;

  insert into public.payment_events (payment_id, actor_type, event_type, previous_status, new_status, idempotency_key)
  values (v_payment_id, 'system', 'payment_intent_created', null, 'pending', p_idempotency_key);

  v_result := jsonb_build_object('payment_id', v_payment_id);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_payer_id, 'create_rent_to_buy_payment_intent', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

revoke all on function public.create_rent_to_buy_payment_intent(uuid, uuid, uuid, text, numeric, text, text, text) from public, anon, authenticated;
grant execute on function public.create_rent_to_buy_payment_intent(uuid, uuid, uuid, text, numeric, text, text, text) to service_role;
