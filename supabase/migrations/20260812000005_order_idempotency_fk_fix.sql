-- ============================================================
-- Fix: create_order_payment_intent / mark_order_paid were scoping
-- idempotency_keys by p_order_id, but idempotency_keys.merchant_id has
-- a live FK to profiles(id) (confirmed via pg_constraint:
-- idempotency_keys_merchant_id_fkey -> profiles(id)). An order id is
-- never a profiles.id, so every real call hit a foreign key violation
-- (23503) -- caught live during order-flow verification, checkout
-- failed 100% of the time. Every other order RPC already scopes by a
-- real actor profile id (p_buyer_id / p_actor_user_id); these two are
-- corrected to do the same, using the order's own buyer_id as the
-- payer/acting id, resolved from the order row before the idempotency
-- check so the lookup only happens once.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

create or replace function public.create_order_payment_intent(
  p_order_id uuid,
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
  v_order record;
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

  select id, buyer_id, seller_id into v_order
  from public.orders
  where id = p_order_id;

  if v_order.id is null then
    raise exception 'order not found';
  end if;

  v_request_hash := md5(
    coalesce(p_order_id::text, '') || '|' || coalesce(p_amount::text, '') || '|' ||
    coalesce(p_currency, '') || '|' || coalesce(p_provider, '')
  );

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = v_order.buyer_id and operation = 'create_order_payment_intent' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  insert into public.payments (order_id, renter_id, merchant_id, payment_type, status, amount, currency, provider, idempotency_key)
  values (p_order_id, v_order.buyer_id, v_order.seller_id, 'order_payment', 'pending', p_amount, p_currency, p_provider, p_idempotency_key)
  returning id into v_payment_id;

  insert into public.payment_events (payment_id, actor_type, event_type, previous_status, new_status, idempotency_key)
  values (v_payment_id, 'system', 'payment_intent_created', null, 'pending', p_idempotency_key);

  v_result := jsonb_build_object('payment_id', v_payment_id, 'status', 'pending');

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (v_order.buyer_id, 'create_order_payment_intent', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

create or replace function public.mark_order_paid(
  p_order_id uuid,
  p_payment_id uuid default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order record;
  v_request_hash text;
  v_idem record;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;

  select id, buyer_id, status into v_order from public.orders where id = p_order_id for update;

  if v_order.id is null then
    raise exception 'order not found';
  end if;

  v_request_hash := md5(coalesce(p_order_id::text, '') || '|' || coalesce(p_payment_id::text, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = v_order.buyer_id and operation = 'mark_order_paid' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  if v_order.status = 'paid' then
    -- Already paid (e.g. a genuine retry racing a prior success) --
    -- naturally idempotent, not an error.
    v_result := jsonb_build_object('order_id', p_order_id, 'status', 'paid');
    return v_result;
  end if;
  if v_order.status <> 'pending' then
    raise exception 'this order is not awaiting payment';
  end if;

  update public.orders set status = 'paid', paid_at = now() where id = p_order_id;

  insert into public.order_history (order_id, actor_user_id, actor_role, event_type, previous_status, new_status, metadata, idempotency_key)
  values (p_order_id, null, 'system', 'order_paid', 'pending', 'paid', jsonb_build_object('payment_id', p_payment_id), p_idempotency_key);

  v_result := jsonb_build_object('order_id', p_order_id, 'status', 'paid');

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (v_order.buyer_id, 'mark_order_paid', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;
