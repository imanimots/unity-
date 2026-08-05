-- ============================================================
-- Buying & selling checkout — order RPCs
-- ============================================================
-- create_order / mark_order_paid / mark_order_shipped /
-- confirm_order_delivery / cancel_order.
--
-- Every RPC follows the exact skeleton from
-- 20260730000007_booking_rpcs.sql: security definer, set search_path =
-- public, auth.role() <> 'service_role' hard-blocked, idempotency via
-- the existing idempotency_keys table, actor role/party derived from
-- the row -- never a client-claimed role param.
--
-- Unlike bookings (which have no "paid" status at all -- financial
-- readiness is always derived, never persisted), order_status already
-- has a real 'paid' value in its enum
-- (20260720000003_buying_selling_schema.sql) -- so payment success is a
-- real, persisted status transition here, not a derived-readiness
-- check. mark_order_paid is called by the payment orchestrator (JS)
-- immediately after a successful charge, not by an end user directly.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

-- ─────────────────────────────────────────
-- create_order
-- ─────────────────────────────────────────
create or replace function public.create_order(
  p_buyer_id uuid,
  p_listing_id uuid,
  p_quantity int default 1,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_listing record;
  v_request_hash text;
  v_idem record;
  v_order_id uuid;
  v_reference text;
  v_total numeric(12,2);
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_buyer_id is null then
    raise exception 'not authenticated';
  end if;
  if p_quantity is null or p_quantity < 1 then
    raise exception 'quantity must be at least 1';
  end if;

  v_request_hash := md5(coalesce(p_listing_id::text, '') || '|' || coalesce(p_quantity::text, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_buyer_id and operation = 'create_order' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  -- Row-locked for the duration of this transaction -- the actual
  -- guarantee against overselling is this lock plus the atomic decrement
  -- below, not the pre-check read on its own.
  select id, merchant_id, status, listing_type, sale_price, quantity_available, shipping_payer
  into v_listing
  from public.listings
  where id = p_listing_id
  for update;

  if v_listing.id is null or v_listing.status <> 'active' or v_listing.listing_type not in ('sale', 'both') or v_listing.sale_price is null then
    raise exception 'listing not found or not available for purchase';
  end if;
  if v_listing.merchant_id = p_buyer_id then
    raise exception 'you cannot buy your own listing';
  end if;
  if exists (select 1 from public.barter_locked_listings where listing_id = p_listing_id) then
    raise exception 'this listing is currently committed to a barter agreement';
  end if;
  if v_listing.quantity_available < p_quantity then
    raise exception 'insufficient stock available for the requested quantity';
  end if;

  update public.listings set quantity_available = quantity_available - p_quantity where id = p_listing_id;

  v_total := v_listing.sale_price * p_quantity; -- shipping_fee is always 0 this pass -- no shipping-cost model exists yet, see docs/BUYING_SELLING.md known limitations
  v_reference := public.generate_order_reference();

  insert into public.orders (
    order_reference, listing_id, buyer_id, seller_id, quantity, unit_price, shipping_fee, total_amount, status
  ) values (
    v_reference, p_listing_id, p_buyer_id, v_listing.merchant_id, p_quantity, v_listing.sale_price, 0, v_total, 'pending'
  )
  returning id into v_order_id;

  insert into public.order_history (order_id, actor_user_id, actor_role, event_type, new_status, metadata, idempotency_key)
  values (v_order_id, p_buyer_id, 'buyer', 'order_created', 'pending', jsonb_build_object('quantity', p_quantity, 'unit_price', v_listing.sale_price), p_idempotency_key);

  v_result := jsonb_build_object('order_id', v_order_id, 'order_reference', v_reference, 'status', 'pending', 'total_amount', v_total);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_buyer_id, 'create_order', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

-- ─────────────────────────────────────────
-- mark_order_paid -- called by the payment orchestrator (JS) right
-- after a successful charge, not by an end user directly. No actor
-- role check beyond service_role since there is no "turn" concept here.
-- ─────────────────────────────────────────
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

  v_request_hash := md5(coalesce(p_order_id::text, '') || '|' || coalesce(p_payment_id::text, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_order_id and operation = 'mark_order_paid' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select id, status into v_order from public.orders where id = p_order_id for update;

  if v_order.id is null then
    raise exception 'order not found';
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
    values (p_order_id, 'mark_order_paid', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

-- ─────────────────────────────────────────
-- mark_order_shipped -- seller only.
-- ─────────────────────────────────────────
create or replace function public.mark_order_shipped(
  p_actor_user_id uuid,
  p_order_id uuid,
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
  if p_actor_user_id is null then
    raise exception 'not authenticated';
  end if;

  v_request_hash := md5(coalesce(p_order_id::text, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_actor_user_id and operation = 'mark_order_shipped' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select id, seller_id, status into v_order from public.orders where id = p_order_id for update;

  if v_order.id is null or v_order.seller_id <> p_actor_user_id then
    raise exception 'order not found or you are not the seller';
  end if;
  if v_order.status <> 'paid' then
    raise exception 'this order is not ready to be marked as shipped';
  end if;

  update public.orders set status = 'shipped', shipped_at = now() where id = p_order_id;

  insert into public.order_history (order_id, actor_user_id, actor_role, event_type, previous_status, new_status, idempotency_key)
  values (p_order_id, p_actor_user_id, 'seller', 'order_shipped', 'paid', 'shipped', p_idempotency_key);

  v_result := jsonb_build_object('order_id', p_order_id, 'status', 'shipped');

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_actor_user_id, 'mark_order_shipped', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

-- ─────────────────────────────────────────
-- confirm_order_delivery -- buyer only, terminal success state.
-- ─────────────────────────────────────────
create or replace function public.confirm_order_delivery(
  p_actor_user_id uuid,
  p_order_id uuid,
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
  if p_actor_user_id is null then
    raise exception 'not authenticated';
  end if;

  v_request_hash := md5(coalesce(p_order_id::text, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_actor_user_id and operation = 'confirm_order_delivery' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select id, buyer_id, status into v_order from public.orders where id = p_order_id for update;

  if v_order.id is null or v_order.buyer_id <> p_actor_user_id then
    raise exception 'order not found or you are not the buyer';
  end if;
  if v_order.status <> 'shipped' then
    raise exception 'this order has not been marked as shipped yet';
  end if;

  update public.orders set status = 'delivered', delivered_at = now() where id = p_order_id;

  insert into public.order_history (order_id, actor_user_id, actor_role, event_type, previous_status, new_status, idempotency_key)
  values (p_order_id, p_actor_user_id, 'buyer', 'order_delivered', 'shipped', 'delivered', p_idempotency_key);

  v_result := jsonb_build_object('order_id', p_order_id, 'status', 'delivered');

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_actor_user_id, 'confirm_order_delivery', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

-- ─────────────────────────────────────────
-- cancel_order -- either party, derived from the row. Allowed only
-- while 'pending' or 'paid' (pre-shipment) -- once 'shipped' the item is
-- physically in transit and self-service cancellation stops, mirroring
-- cancel_booking's "active bookings can only be cancelled through an
-- administrative process" rule. Restores quantity_available always;
-- does NOT auto-refund a captured payment (same precedent as
-- cancel_booking, which also never calls transition_payment_status --
-- refund processing on a paid-then-cancelled order is a documented
-- follow-up, not silently assumed to have happened).
-- ─────────────────────────────────────────
create or replace function public.cancel_order(
  p_actor_user_id uuid,
  p_order_id uuid,
  p_cancellation_reason text default null,
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
  if p_actor_user_id is null then
    raise exception 'not authenticated';
  end if;

  v_request_hash := md5(coalesce(p_order_id::text, '') || '|' || coalesce(p_cancellation_reason, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_actor_user_id and operation = 'cancel_order' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select id, buyer_id, seller_id, listing_id, quantity, status into v_order
  from public.orders where id = p_order_id for update;

  if v_order.id is null or (v_order.buyer_id <> p_actor_user_id and v_order.seller_id <> p_actor_user_id) then
    raise exception 'order not found or you are not a party to it';
  end if;
  if v_order.status = 'shipped' or v_order.status = 'delivered' then
    raise exception 'this order has already shipped and can only be cancelled through an administrative process';
  end if;
  if v_order.status = 'cancelled' then
    raise exception 'this order has already been cancelled';
  end if;

  update public.listings set quantity_available = quantity_available + v_order.quantity where id = v_order.listing_id;

  update public.orders set
    status = 'cancelled',
    cancelled_at = now(),
    cancelled_by = p_actor_user_id,
    cancellation_reason = p_cancellation_reason
  where id = p_order_id;

  insert into public.order_history (order_id, actor_user_id, actor_role, event_type, previous_status, new_status, metadata, idempotency_key)
  values (
    p_order_id, p_actor_user_id,
    case when p_actor_user_id = v_order.buyer_id then 'buyer' else 'seller' end,
    'order_cancelled', v_order.status, 'cancelled',
    jsonb_build_object('cancellation_reason', p_cancellation_reason), p_idempotency_key
  );

  v_result := jsonb_build_object('order_id', p_order_id, 'status', 'cancelled');

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_actor_user_id, 'cancel_order', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

-- ─────────────────────────────────────────
-- Grants -- service_role only, exactly matching every existing RPC file.
-- ─────────────────────────────────────────
revoke all on function public.create_order(uuid, uuid, int, text) from public, anon, authenticated;
grant execute on function public.create_order(uuid, uuid, int, text) to service_role;

revoke all on function public.mark_order_paid(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.mark_order_paid(uuid, uuid, text) to service_role;

revoke all on function public.mark_order_shipped(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.mark_order_shipped(uuid, uuid, text) to service_role;

revoke all on function public.confirm_order_delivery(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.confirm_order_delivery(uuid, uuid, text) to service_role;

revoke all on function public.cancel_order(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.cancel_order(uuid, uuid, text, text) to service_role;
