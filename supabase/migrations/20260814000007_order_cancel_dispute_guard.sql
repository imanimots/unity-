-- ============================================================
-- Step 11 Phase 2 -- fix cancel_order: disputed orders were still
-- cancellable
-- ============================================================
-- Found by the new permanent regression script,
-- scripts/verify-dispute-locking.mjs: cancel_booking and
-- cancel_barter_agreement both use an allow-list/exact-match status
-- guard, so a 'disputed' order/booking/barter agreement naturally
-- falls outside what they permit -- verified live before Phase 2's
-- migrations were even written. cancel_order was never re-checked the
-- same way and turned out to use a BLOCKLIST instead
-- (`status = 'shipped' or status = 'delivered'` / `status =
-- 'cancelled'`) -- 'disputed' was never in that blocklist, so a
-- disputed order could still be cancelled, silently restoring stock
-- and overwriting the disputed status entirely. This predates Step 11
-- Phase 2 (cancel_order was written during the Orders phase, before
-- disputes existed) but is now a real, live gap in the dispute freeze
-- this phase depends on.
--
-- Straight CREATE OR REPLACE of a proven function, one new guard
-- clause added, everything else byte-identical to the live definition
-- captured via pg_get_functiondef immediately before writing this
-- migration.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

create or replace function public.cancel_order(p_actor_user_id uuid, p_order_id uuid, p_cancellation_reason text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
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
  if v_order.status = 'disputed' then
    raise exception 'this order is currently disputed and can only be cancelled through an administrative process';
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
$function$;
