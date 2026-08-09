-- ============================================================
-- Phase 3 -- fix-forward correction, found via live corrective-
-- verification testing (item 5): release_escrow_transaction() has
-- ALWAYS gated only on escrow.status = 'funded' plus
-- _escrow_transaction_dispute_block() -- it has never independently
-- verified that the underlying order/booking/barter transaction
-- actually reached its own terminal completion state. This predates
-- migration 007 (007 only changed the DISPUTE-freeze signal for
-- orders/barter; it never added or removed a completion check, because
-- none existed for any branch).
--
-- Confirmed live and exploitable via the admin override path: an order
-- that was only 'shipped' (never 'delivered'), then disputed and
-- resolved favor_respondent, could have its escrow released purely
-- because the dispute was resolved -- "resolved dispute alone" WAS
-- sufficient, exactly the failure mode item 5 asked to rule out. The
-- automatic/system release path was never actually exposed to this (it
-- only ever calls release right after the real completion RPC --
-- confirm_order_delivery/confirm_return/confirm_barter_completion --
-- already succeeded), but the admin override path had no such
-- protection.
--
-- Fix: a new _escrow_transaction_completion_block() check, called
-- alongside the existing dispute-block check inside
-- release_escrow_transaction() (CREATE OR REPLACE -- migration 007
-- itself is untouched).
--   - booking: bookings.status = 'completed' is authoritative and
--     already correctly restored by resolve_dispute() for
--     outcome = 'favor_respondent' (the existing, unmodified fix from
--     20260824000002) -- checked directly, no fallback needed.
--   - order / barter: the live status can never reliably signal
--     completion once ever disputed (orders.status/
--     barter_agreements.status are never restored -- the same
--     pre-existing gap migration 007 already documented). Falls back to
--     the dispute's own captured pre_dispute_status, exactly mirroring
--     the SAME favor_respondent-only rule bookings get automatically --
--     if a favor_respondent-resolved dispute's pre_dispute_status was
--     already the terminal value ('delivered' / 'completed') BEFORE the
--     dispute was ever opened, the transaction was genuinely complete
--     and release may proceed; otherwise it stays blocked. This reads
--     data the dispute system already writes (open_dispute() captures
--     pre_dispute_status for all three transaction types) -- it does
--     not touch, redesign, or duplicate any dispute RPC.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

create or replace function public._escrow_transaction_completion_block(p_escrow public.escrow_transactions)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking_status text;
  v_order_status text;
  v_barter_status text;
  v_favorable record;
begin
  if p_escrow.booking_id is not null then
    select status::text into v_booking_status from public.bookings where id = p_escrow.booking_id;
    if v_booking_status = 'completed' then
      return null;
    end if;
    return 'transaction_not_completed';

  elsif p_escrow.order_id is not null then
    select status::text into v_order_status from public.orders where id = p_escrow.order_id;
    if v_order_status = 'delivered' then
      return null;
    end if;
    select pre_dispute_status, outcome into v_favorable
    from public.disputes
    where order_id = p_escrow.order_id and outcome = 'favor_respondent' and status in ('resolved', 'closed')
    order by created_at desc
    limit 1;
    if v_favorable.pre_dispute_status = 'delivered' then
      return null;
    end if;
    return 'transaction_not_completed';

  elsif p_escrow.barter_agreement_id is not null then
    select status::text into v_barter_status from public.barter_agreements where id = p_escrow.barter_agreement_id;
    if v_barter_status = 'completed' then
      return null;
    end if;
    select pre_dispute_status, outcome into v_favorable
    from public.disputes
    where barter_agreement_id = p_escrow.barter_agreement_id and outcome = 'favor_respondent' and status in ('resolved', 'closed')
    order by created_at desc
    limit 1;
    if v_favorable.pre_dispute_status = 'completed' then
      return null;
    end if;
    return 'transaction_not_completed';
  end if;

  return 'transaction_not_completed';
end;
$$;

create or replace function public.release_escrow_transaction(
  p_actor_type text,
  p_actor_id uuid,
  p_escrow_id uuid,
  p_released_to uuid,
  p_reason text default null,
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
  v_escrow public.escrow_transactions;
  v_block text;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_actor_type not in ('system', 'admin') then
    raise exception 'invalid actor type';
  end if;
  if p_actor_type = 'admin' and (p_reason is null or length(trim(p_reason)) = 0) then
    raise exception 'a reason is required for an admin-initiated release';
  end if;

  if p_actor_type = 'admin' and p_idempotency_key is not null then
    v_request_hash := md5(coalesce(p_escrow_id::text, '') || '|' || coalesce(p_released_to::text, '') || '|' || coalesce(p_reason, ''));
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_actor_id and operation = 'release_escrow_transaction' and idempotency_key = p_idempotency_key;
    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select * into v_escrow from public.escrow_transactions where id = p_escrow_id;
  if v_escrow.id is null then
    raise exception 'escrow transaction not found';
  end if;
  if v_escrow.status <> 'funded' then
    raise exception 'escrow transaction is in status % and cannot be released from here', v_escrow.status;
  end if;

  v_block := public._escrow_transaction_dispute_block(v_escrow);
  if v_block is not null then
    raise exception 'escrow transaction is not currently eligible to release: %', v_block;
  end if;

  -- Item 5 fix: a resolved dispute alone must never be sufficient --
  -- the underlying transaction must also have genuinely reached its own
  -- completion/entitlement state (or have been favorably resolved from
  -- one that had).
  v_block := public._escrow_transaction_completion_block(v_escrow);
  if v_block is not null then
    raise exception 'escrow transaction is not currently eligible to release: %', v_block;
  end if;

  v_escrow := public._escrow_transaction_transition(
    p_escrow_id, 'released', array['funded']::escrow_status[],
    p_actor_type, p_actor_id, 'released', p_reason, null, p_released_to, null, null, p_idempotency_key
  );

  v_result := jsonb_build_object('escrow_transaction_id', v_escrow.id, 'status', v_escrow.status, 'released_at', v_escrow.released_at, 'released_to', v_escrow.released_to);

  if p_actor_type = 'admin' and p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_actor_id, 'release_escrow_transaction', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

revoke all on function public._escrow_transaction_completion_block(public.escrow_transactions) from public, anon, authenticated;
grant execute on function public._escrow_transaction_completion_block(public.escrow_transactions) to service_role;
