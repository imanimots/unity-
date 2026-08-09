-- ============================================================
-- Phase 3 -- Escrow architecture: transaction lifecycle RPCs.
-- ============================================================
-- create_escrow_transaction / mark_escrow_funded are SYSTEM-ONLY,
-- called exclusively from the JS orchestrator (src/lib/escrow/
-- orchestrator/) immediately after the underlying payment intent is
-- created / the underlying payment is captured -- never user-invoked,
-- so they use natural state-based idempotency (a unique(payment_id)
-- constraint for create; "already funded with this reference" for
-- fund) rather than the idempotency_keys table, which requires a real
-- profile id the system-triggered path doesn't have.
--
-- release_escrow_transaction / refund_escrow_transaction /
-- cancel_escrow_transaction are reachable from BOTH the JS orchestrator
-- (system actor, at the transaction's own completion point) and the
-- narrow admin override routes (admin actor, reason required) -- both
-- have a real profile id, so both use the standard idempotency_keys
-- pattern exactly like mark_payout_paid/mark_payout_failed.
--
-- release_escrow_transaction is blocked while the underlying booking/
-- order/barter agreement has an unresolved dispute -- reusing the SAME
-- signal (status = 'disputed' / an unresolved disputes row) every other
-- domain in this codebase already checks, never a new competing "held"
-- state on escrow_transactions itself. Refund is deliberately NOT
-- blocked by a dispute (returning money to the payer is the safe
-- direction during a dispute -- payout eligibility must remain strict,
-- refund eligibility does not need to be).
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

-- ------------------------------------------------------------
-- CREATE -- system-only, natural idempotency via unique(payment_id).
-- ------------------------------------------------------------
create or replace function public.create_escrow_transaction(
  p_transaction_type text,
  p_order_id uuid,
  p_booking_id uuid,
  p_barter_agreement_id uuid,
  p_payment_id uuid,
  p_principal_amount numeric,
  p_secure_transaction_fee_amount numeric,
  p_currency text,
  p_provider text,
  p_provider_reference text,
  p_idempotency_key text default null
)
returns public.escrow_transactions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_escrow public.escrow_transactions;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_payment_id is null then
    raise exception 'payment_id is required';
  end if;

  begin
    insert into public.escrow_transactions (
      transaction_type, order_id, booking_id, barter_agreement_id, payment_id,
      principal_amount, secure_transaction_fee_amount, currency, provider, provider_reference, idempotency_key
    ) values (
      p_transaction_type, p_order_id, p_booking_id, p_barter_agreement_id, p_payment_id,
      p_principal_amount, p_secure_transaction_fee_amount, p_currency, p_provider, p_provider_reference, p_idempotency_key
    )
    returning * into v_escrow;

    insert into public.escrow_transaction_history (
      escrow_transaction_id, previous_status, new_status, actor_type, action, idempotency_key
    ) values (
      v_escrow.id, null, 'pending', 'system', 'created', p_idempotency_key
    );
  exception when unique_violation then
    select * into v_escrow from public.escrow_transactions where payment_id = p_payment_id;
  end;

  return v_escrow;
end;
$$;

-- ------------------------------------------------------------
-- Shared internal transition helper. Locks the row FOR UPDATE, validates
-- the allowed-from-status array, captures previous_status from the
-- initial locking read (never a post-update re-query), writes one
-- history row, returns the updated row -- mirrors
-- _merchant_payout_transition()'s exact shape.
-- ------------------------------------------------------------
create or replace function public._escrow_transaction_transition(
  p_escrow_id uuid,
  p_new_status escrow_status,
  p_allowed_from escrow_status[],
  p_actor_type text,
  p_actor_id uuid,
  p_action text,
  p_reason text default null,
  p_provider_reference text default null,
  p_released_to uuid default null,
  p_refund_amount numeric default null,
  p_failure_reason text default null,
  p_idempotency_key text default null
)
returns public.escrow_transactions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_escrow public.escrow_transactions;
  v_previous_status escrow_status;
begin
  select * into v_escrow from public.escrow_transactions where id = p_escrow_id for update;
  if v_escrow.id is null then
    raise exception 'escrow transaction not found';
  end if;
  if not (v_escrow.status = any(p_allowed_from)) then
    raise exception 'escrow transaction is in status % and cannot transition to % from here', v_escrow.status, p_new_status;
  end if;
  v_previous_status := v_escrow.status;

  update public.escrow_transactions
  set status = p_new_status,
      provider_reference = coalesce(p_provider_reference, provider_reference),
      funded_at = case when p_new_status = 'funded' then now() else funded_at end,
      released_at = case when p_new_status = 'released' then now() else released_at end,
      released_to = case when p_new_status = 'released' then p_released_to else released_to end,
      release_reason = case when p_new_status = 'released' then p_reason else release_reason end,
      refunded_at = case when p_new_status in ('refunded', 'partially_refunded') then now() else refunded_at end,
      refunded_amount = case when p_new_status in ('refunded', 'partially_refunded') then coalesce(p_refund_amount, refunded_amount) else refunded_amount end,
      cancelled_at = case when p_new_status = 'cancelled' then now() else cancelled_at end,
      failure_reason = case when p_new_status = 'failed' then p_failure_reason else failure_reason end,
      version = version + 1
  where id = p_escrow_id
  returning * into v_escrow;

  insert into public.escrow_transaction_history (
    escrow_transaction_id, previous_status, new_status, actor_type, actor_id, action, reason, provider_reference, idempotency_key
  ) values (
    v_escrow.id, v_previous_status::text, p_new_status::text, p_actor_type, p_actor_id, p_action, p_reason, p_provider_reference, p_idempotency_key
  );

  return v_escrow;
end;
$$;

-- ------------------------------------------------------------
-- Dispute-freeze check, reusing the existing per-domain dispute signal
-- (never a new competing state). Returns a block reason or null.
-- ------------------------------------------------------------
create or replace function public._escrow_transaction_dispute_block(p_escrow public.escrow_transactions)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_escrow.booking_id is not null then
    if exists (select 1 from public.bookings where id = p_escrow.booking_id and status = 'disputed') then
      return 'unresolved_dispute';
    end if;
    if exists (select 1 from public.disputes where booking_id = p_escrow.booking_id and status not in ('resolved', 'closed', 'cancelled')) then
      return 'unresolved_dispute';
    end if;
  elsif p_escrow.order_id is not null then
    if exists (select 1 from public.orders where id = p_escrow.order_id and status = 'disputed') then
      return 'unresolved_dispute';
    end if;
    if exists (select 1 from public.disputes where order_id = p_escrow.order_id and status not in ('resolved', 'closed', 'cancelled')) then
      return 'unresolved_dispute';
    end if;
  elsif p_escrow.barter_agreement_id is not null then
    if exists (select 1 from public.barter_agreements where id = p_escrow.barter_agreement_id and status = 'disputed') then
      return 'unresolved_dispute';
    end if;
    if exists (select 1 from public.disputes where barter_agreement_id = p_escrow.barter_agreement_id and status not in ('resolved', 'closed', 'cancelled')) then
      return 'unresolved_dispute';
    end if;
  end if;
  return null;
end;
$$;

-- ------------------------------------------------------------
-- MARK ESCROW FUNDED -- pending -> funded. System-only, called right
-- after the underlying payment's own capture already succeeded (never
-- itself calls a payment provider). Naturally idempotent: already
-- funded with the same reference is a no-op success, not an error.
-- ------------------------------------------------------------
create or replace function public.mark_escrow_funded(
  p_escrow_id uuid,
  p_provider_reference text,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_escrow public.escrow_transactions;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;

  select * into v_escrow from public.escrow_transactions where id = p_escrow_id;
  if v_escrow.id is null then
    raise exception 'escrow transaction not found';
  end if;

  if v_escrow.status = 'funded' then
    v_result := jsonb_build_object('escrow_transaction_id', v_escrow.id, 'status', v_escrow.status);
    return v_result;
  end if;

  v_escrow := public._escrow_transaction_transition(
    p_escrow_id, 'funded', array['pending']::escrow_status[],
    'system', null, 'funded', null, p_provider_reference, null, null, null, p_idempotency_key
  );

  v_result := jsonb_build_object('escrow_transaction_id', v_escrow.id, 'status', v_escrow.status, 'funded_at', v_escrow.funded_at);
  return v_result;
end;
$$;

-- ------------------------------------------------------------
-- RELEASE -- funded -> released. Blocked while the underlying
-- transaction has an unresolved dispute. Reachable by a system actor
-- (automatic, at the transaction's own completion point) or an admin
-- (manual override, reason required) -- both idempotency-keyed.
-- ------------------------------------------------------------
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

-- ------------------------------------------------------------
-- REFUND -- funded -> refunded/partially_refunded. NOT blocked by an
-- unresolved dispute (returning money to the payer is the safe
-- direction). Admin-only in this phase (no automatic refund trigger
-- exists yet -- create_refund itself has no live call site today,
-- confirmed by audit -- see docs/ESCROW_ARCHITECTURE.md).
-- ------------------------------------------------------------
create or replace function public.refund_escrow_transaction(
  p_admin_id uuid,
  p_escrow_id uuid,
  p_amount numeric,
  p_reason text,
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
  v_new_status escrow_status;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_admin_id is null then
    raise exception 'not authenticated';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a reason is required to refund an escrow transaction';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'refund amount must be positive';
  end if;

  v_request_hash := md5(coalesce(p_escrow_id::text, '') || '|' || coalesce(p_amount::text, '') || '|' || coalesce(p_reason, ''));
  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_admin_id and operation = 'refund_escrow_transaction' and idempotency_key = p_idempotency_key;
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
    raise exception 'escrow transaction is in status % and cannot be refunded from here', v_escrow.status;
  end if;
  if p_amount > v_escrow.principal_amount then
    raise exception 'refund amount exceeds the held principal amount';
  end if;

  v_new_status := case when p_amount = v_escrow.principal_amount then 'refunded' else 'partially_refunded' end;

  v_escrow := public._escrow_transaction_transition(
    p_escrow_id, v_new_status, array['funded']::escrow_status[],
    'admin', p_admin_id, 'refunded', p_reason, null, null, p_amount, null, p_idempotency_key
  );

  v_result := jsonb_build_object('escrow_transaction_id', v_escrow.id, 'status', v_escrow.status, 'refunded_at', v_escrow.refunded_at, 'refunded_amount', v_escrow.refunded_amount);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_admin_id, 'refund_escrow_transaction', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

-- ------------------------------------------------------------
-- CANCEL -- pending -> cancelled only. A never-funded escrow row can be
-- voided directly (nothing was ever attempted with a provider), same
-- reasoning as payments' pending -> cancelled path. Admin-only.
-- ------------------------------------------------------------
create or replace function public.cancel_escrow_transaction(
  p_admin_id uuid,
  p_escrow_id uuid,
  p_reason text,
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
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_admin_id is null then
    raise exception 'not authenticated';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a reason is required to cancel an escrow transaction';
  end if;

  v_request_hash := md5(coalesce(p_escrow_id::text, '') || '|' || coalesce(p_reason, ''));
  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_admin_id and operation = 'cancel_escrow_transaction' and idempotency_key = p_idempotency_key;
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
  if v_escrow.status <> 'pending' then
    raise exception 'escrow transaction is in status % and cannot be cancelled from here', v_escrow.status;
  end if;

  v_escrow := public._escrow_transaction_transition(
    p_escrow_id, 'cancelled', array['pending']::escrow_status[],
    'admin', p_admin_id, 'cancelled', p_reason, null, null, null, null, p_idempotency_key
  );

  v_result := jsonb_build_object('escrow_transaction_id', v_escrow.id, 'status', v_escrow.status, 'cancelled_at', v_escrow.cancelled_at);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_admin_id, 'cancel_escrow_transaction', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

revoke all on function public.create_escrow_transaction(text, uuid, uuid, uuid, uuid, numeric, numeric, text, text, text, text) from public, anon, authenticated;
grant execute on function public.create_escrow_transaction(text, uuid, uuid, uuid, uuid, numeric, numeric, text, text, text, text) to service_role;

revoke all on function public._escrow_transaction_transition(uuid, escrow_status, escrow_status[], text, uuid, text, text, text, uuid, numeric, text, text) from public, anon, authenticated;
grant execute on function public._escrow_transaction_transition(uuid, escrow_status, escrow_status[], text, uuid, text, text, text, uuid, numeric, text, text) to service_role;

revoke all on function public._escrow_transaction_dispute_block(public.escrow_transactions) from public, anon, authenticated;
grant execute on function public._escrow_transaction_dispute_block(public.escrow_transactions) to service_role;

revoke all on function public.mark_escrow_funded(uuid, text, text) from public, anon, authenticated;
grant execute on function public.mark_escrow_funded(uuid, text, text) to service_role;

revoke all on function public.release_escrow_transaction(text, uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.release_escrow_transaction(text, uuid, uuid, uuid, text, text) to service_role;

revoke all on function public.refund_escrow_transaction(uuid, uuid, numeric, text, text) from public, anon, authenticated;
grant execute on function public.refund_escrow_transaction(uuid, uuid, numeric, text, text) to service_role;

revoke all on function public.cancel_escrow_transaction(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.cancel_escrow_transaction(uuid, uuid, text, text) to service_role;
