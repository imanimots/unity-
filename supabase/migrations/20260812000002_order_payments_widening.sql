-- ============================================================
-- Buying & selling checkout — payments widening for orders
-- ============================================================
-- payments.booking_id was NOT NULL until now -- widened here to a
-- nullable booking_id + a new nullable order_id, mutually exclusive via
-- a CHECK, mirroring the exact dual-purpose-FK precedent already used
-- for disputes/messages (booking_id/order_id, 20260720000003) and
-- planned for barter (barter_agreement_id, Phase B, not yet applied).
-- When barter's own payments widening lands, this CHECK becomes a
-- 3-way exactly-one-of -- documented there, not here.
--
-- payments.renter_id/merchant_id are repurposed as generic payer/
-- counterparty ids for order rows (buyer/seller) -- the same repurposing
-- precedent already established for idempotency_keys.merchant_id (used
-- as a generic "acting user id" by the booking RPCs).
--
-- create_payment_intent() itself is left completely untouched (it hard-
-- selects from bookings) -- a new sibling create_order_payment_intent()
-- is added instead, matching the create_barter_payment_intent()
-- precedent rather than risking a CREATE OR REPLACE of proven code.
-- transition_payment_status()/record_payment_attempt() are already
-- fully generic (scoped by payment_id, never booking_id) and need no
-- change at all.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

alter table public.payments alter column booking_id drop not null;
alter table public.payments add column if not exists order_id uuid references public.orders(id);

alter table public.payments add constraint payments_one_transaction_chk check (
  (booking_id is not null and order_id is null)
  or (booking_id is null and order_id is not null)
);

-- payments_booking_type_unique (booking_id, payment_type) is untouched
-- and keeps working for booking rows (NULL order_id never collides in a
-- unique constraint). Orders only ever have one payment_type
-- ('order_payment'), so a plain (order_id, payment_type) unique suffices
-- -- no "both parties pay" case exists for a purchase the way it does
-- for a barter deposit.
alter table public.payments add constraint payments_order_type_unique unique (order_id, payment_type);

create index if not exists payments_order_idx on public.payments(order_id);

-- ─────────────────────────────────────────
-- create_order_payment_intent -- sibling of create_payment_intent(),
-- same shape, scoped to orders. buyer_id/seller_id are looked up from
-- the order row itself, never trusted from a parameter.
-- ─────────────────────────────────────────
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

  v_request_hash := md5(
    coalesce(p_order_id::text, '') || '|' || coalesce(p_amount::text, '') || '|' ||
    coalesce(p_currency, '') || '|' || coalesce(p_provider, '')
  );

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_order_id and operation = 'create_order_payment_intent' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select id, buyer_id, seller_id into v_order
  from public.orders
  where id = p_order_id;

  if v_order.id is null then
    raise exception 'order not found';
  end if;

  insert into public.payments (order_id, renter_id, merchant_id, payment_type, status, amount, currency, provider, idempotency_key)
  values (p_order_id, v_order.buyer_id, v_order.seller_id, 'order_payment', 'pending', p_amount, p_currency, p_provider, p_idempotency_key)
  returning id into v_payment_id;

  insert into public.payment_events (payment_id, actor_type, event_type, previous_status, new_status, idempotency_key)
  values (v_payment_id, 'system', 'payment_intent_created', null, 'pending', p_idempotency_key);

  v_result := jsonb_build_object('payment_id', v_payment_id, 'status', 'pending');

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_order_id, 'create_order_payment_intent', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

revoke all on function public.create_order_payment_intent(uuid, numeric, text, text, text) from public, anon, authenticated;
grant execute on function public.create_order_payment_intent(uuid, numeric, text, text, text) to service_role;
