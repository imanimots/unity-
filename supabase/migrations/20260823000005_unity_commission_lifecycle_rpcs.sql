-- ============================================================
-- Unity Phase 2 -- Commission Framework
-- Lifecycle RPCs. Mirrors affiliate's _affiliate_commission_transition /
-- hold / release / void / create_adjustment shape almost exactly --
-- same shared-transition-helper pattern, same
-- system-or-admin-actor convention. Every RPC: security definer,
-- service-role-only, actor id always an explicit parameter never
-- auth.uid(), reason required wherever a reason is meaningful.
--
-- Callable by both 'system' (the internal reconciliation sweep) and
-- 'admin' (a narrow, reason-required manual override) -- never by an
-- ordinary client directly (auth.role() check + zero client write
-- policies on unity_commissions already established in
-- 20260823000002).
-- ============================================================

create or replace function public._unity_commission_transition(
  p_commission_id uuid,
  p_new_status public.unity_commission_status,
  p_allowed_from public.unity_commission_status[],
  p_actor_type text,
  p_actor_id uuid,
  p_reason text default null,
  p_idempotency_key text default null
)
returns public.unity_commissions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_commission public.unity_commissions;
  v_previous_status public.unity_commission_status;
begin
  select * into v_commission from public.unity_commissions where id = p_commission_id for update;
  if v_commission.id is null then
    raise exception 'commission not found';
  end if;
  if not (v_commission.status = any(p_allowed_from)) then
    raise exception 'commission is in status % and cannot transition to % from here', v_commission.status, p_new_status;
  end if;
  v_previous_status := v_commission.status;

  update public.unity_commissions
  set status = p_new_status,
      hold_reason = case when p_new_status = 'held' then p_reason else hold_reason end,
      void_reason = case when p_new_status = 'voided' then p_reason else void_reason end,
      earned_at = case when p_new_status = 'earned' then now() else earned_at end
  where id = p_commission_id
  returning * into v_commission;

  insert into public.unity_commission_history (
    commission_id, payment_id, previous_status, new_status, actor_type, actor_id, reason, idempotency_key
  ) values (
    v_commission.id, v_commission.payment_id, v_previous_status::text, p_new_status::text,
    p_actor_type, p_actor_id, p_reason, p_idempotency_key
  );

  return v_commission;
end;
$$;

revoke all on function public._unity_commission_transition(uuid, public.unity_commission_status, public.unity_commission_status[], text, uuid, text, text) from public, anon, authenticated;
grant execute on function public._unity_commission_transition(uuid, public.unity_commission_status, public.unity_commission_status[], text, uuid, text, text) to service_role;

-- ─────────────────────────────────────────
-- HOLD_UNITY_COMMISSION -- a dispute opened on the underlying
-- transaction. pending/adjusted -> held.
-- ─────────────────────────────────────────
create or replace function public.hold_unity_commission(
  p_actor_type text,
  p_actor_id uuid,
  p_commission_id uuid,
  p_reason text,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result public.unity_commissions;
  v_request_hash text;
  v_idem record;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_actor_type not in ('system', 'admin') then
    raise exception 'invalid actor type';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a reason is required to hold a commission';
  end if;

  v_request_hash := md5(coalesce(p_commission_id::text, '') || '|' || coalesce(p_reason, ''));
  if p_idempotency_key is not null and p_actor_id is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_actor_id and operation = 'hold_unity_commission' and idempotency_key = p_idempotency_key;
    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  v_result := public._unity_commission_transition(
    p_commission_id, 'held', array['pending', 'adjusted']::public.unity_commission_status[],
    p_actor_type, p_actor_id, p_reason, p_idempotency_key
  );

  if p_idempotency_key is not null and p_actor_id is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_actor_id, 'hold_unity_commission', p_idempotency_key, v_request_hash, jsonb_build_object('commission_id', v_result.id, 'status', v_result.status));
  end if;

  return jsonb_build_object('commission_id', v_result.id, 'status', v_result.status);
end;
$$;

-- ─────────────────────────────────────────
-- RELEASE_UNITY_COMMISSION_HOLD -- held -> pending (re-enters normal
-- reconciliation; does not itself decide earned/adjusted/voided).
-- ─────────────────────────────────────────
create or replace function public.release_unity_commission_hold(
  p_actor_type text,
  p_actor_id uuid,
  p_commission_id uuid,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result public.unity_commissions;
  v_request_hash text;
  v_idem record;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_actor_type not in ('system', 'admin') then
    raise exception 'invalid actor type';
  end if;

  v_request_hash := md5(coalesce(p_commission_id::text, ''));
  if p_idempotency_key is not null and p_actor_id is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_actor_id and operation = 'release_unity_commission_hold' and idempotency_key = p_idempotency_key;
    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  v_result := public._unity_commission_transition(
    p_commission_id, 'pending', array['held']::public.unity_commission_status[],
    p_actor_type, p_actor_id, 'hold released', p_idempotency_key
  );

  if p_idempotency_key is not null and p_actor_id is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_actor_id, 'release_unity_commission_hold', p_idempotency_key, v_request_hash, jsonb_build_object('commission_id', v_result.id, 'status', v_result.status));
  end if;

  return jsonb_build_object('commission_id', v_result.id, 'status', v_result.status);
end;
$$;

-- ─────────────────────────────────────────
-- FINALIZE_UNITY_COMMISSION -- pending -> earned. Called only by the
-- system reconciliation sweep once the review window has passed with no
-- refund/dispute found (Rule 7/9's "ultimately corresponds to the
-- amount that remains economically earned" made concrete: nothing
-- changed, so the full snapshot amount is finalized).
-- ─────────────────────────────────────────
create or replace function public.finalize_unity_commission(
  p_actor_type text,
  p_actor_id uuid,
  p_commission_id uuid,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result public.unity_commissions;
  v_request_hash text;
  v_idem record;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_actor_type not in ('system', 'admin') then
    raise exception 'invalid actor type';
  end if;

  v_request_hash := md5(coalesce(p_commission_id::text, ''));
  if p_idempotency_key is not null and p_actor_id is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_actor_id and operation = 'finalize_unity_commission' and idempotency_key = p_idempotency_key;
    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  v_result := public._unity_commission_transition(
    p_commission_id, 'earned', array['pending']::public.unity_commission_status[],
    p_actor_type, p_actor_id, 'review window passed with no refund or dispute', p_idempotency_key
  );

  if p_idempotency_key is not null and p_actor_id is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_actor_id, 'finalize_unity_commission', p_idempotency_key, v_request_hash, jsonb_build_object('commission_id', v_result.id, 'status', v_result.status));
  end if;

  return jsonb_build_object('commission_id', v_result.id, 'status', v_result.status);
end;
$$;

-- ─────────────────────────────────────────
-- VOID_UNITY_COMMISSION -- any non-voided status -> voided. A fully
-- refunded/cancelled transaction retains R0 Unity commission (Rule 7/8).
-- The original snapshot row is never deleted or rewritten -- voiding is
-- itself a recorded lifecycle transition.
-- ─────────────────────────────────────────
create or replace function public.void_unity_commission(
  p_actor_type text,
  p_actor_id uuid,
  p_commission_id uuid,
  p_reason text,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result public.unity_commissions;
  v_request_hash text;
  v_idem record;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_actor_type not in ('system', 'admin') then
    raise exception 'invalid actor type';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a reason is required to void a commission';
  end if;

  v_request_hash := md5(coalesce(p_commission_id::text, '') || '|' || coalesce(p_reason, ''));
  if p_idempotency_key is not null and p_actor_id is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_actor_id and operation = 'void_unity_commission' and idempotency_key = p_idempotency_key;
    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  v_result := public._unity_commission_transition(
    p_commission_id, 'voided', array['pending', 'held', 'earned', 'adjusted']::public.unity_commission_status[],
    p_actor_type, p_actor_id, p_reason, p_idempotency_key
  );

  if p_idempotency_key is not null and p_actor_id is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_actor_id, 'void_unity_commission', p_idempotency_key, v_request_hash, jsonb_build_object('commission_id', v_result.id, 'status', v_result.status));
  end if;

  return jsonb_build_object('commission_id', v_result.id, 'status', v_result.status);
end;
$$;

-- ─────────────────────────────────────────
-- CREATE_UNITY_COMMISSION_ADJUSTMENT -- append-only correction for a
-- PARTIAL refund: the original commission_amount snapshot is never
-- rewritten; this records a signed delta (negative for a reduction) and
-- moves the commission to 'adjusted'. p_actor_id/p_actor_type may be
-- 'system' (the automatic partial-refund reconciliation sweep) or
-- 'admin' (a manual correction) -- both go through this one function,
-- never a direct UPDATE of unity_commissions' financial fields.
-- ─────────────────────────────────────────
create or replace function public.create_unity_commission_adjustment(
  p_actor_type text,
  p_actor_id uuid,
  p_commission_id uuid,
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
  v_commission public.unity_commissions;
  v_adjustment_id uuid;
  v_request_hash text;
  v_idem record;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_actor_type not in ('system', 'admin') then
    raise exception 'invalid actor type';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a reason is required for an adjustment';
  end if;

  v_request_hash := md5(coalesce(p_commission_id::text, '') || '|' || coalesce(p_amount::text, '') || '|' || coalesce(p_reason, ''));

  if p_idempotency_key is not null and p_actor_id is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_actor_id and operation = 'create_unity_commission_adjustment' and idempotency_key = p_idempotency_key;
    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  insert into public.unity_commission_adjustments (commission_id, amount, reason, created_by, idempotency_key)
  values (p_commission_id, p_amount, p_reason, p_actor_id, p_idempotency_key)
  returning id into v_adjustment_id;

  v_commission := public._unity_commission_transition(
    p_commission_id, 'adjusted', array['pending', 'held', 'earned']::public.unity_commission_status[],
    p_actor_type, p_actor_id, p_reason, p_idempotency_key
  );

  if p_idempotency_key is not null and p_actor_id is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_actor_id, 'create_unity_commission_adjustment', p_idempotency_key, v_request_hash,
      jsonb_build_object('commission_id', v_commission.id, 'adjustment_id', v_adjustment_id, 'status', v_commission.status));
  end if;

  return jsonb_build_object('commission_id', v_commission.id, 'adjustment_id', v_adjustment_id, 'status', v_commission.status);
end;
$$;

-- ─────────────────────────────────────────
-- Grants -- service_role only.
-- ─────────────────────────────────────────
revoke all on function public.hold_unity_commission(text, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.hold_unity_commission(text, uuid, uuid, text, text) to service_role;

revoke all on function public.release_unity_commission_hold(text, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.release_unity_commission_hold(text, uuid, uuid, text) to service_role;

revoke all on function public.finalize_unity_commission(text, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.finalize_unity_commission(text, uuid, uuid, text) to service_role;

revoke all on function public.void_unity_commission(text, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.void_unity_commission(text, uuid, uuid, text, text) to service_role;

revoke all on function public.create_unity_commission_adjustment(text, uuid, uuid, numeric, text, text) from public, anon, authenticated;
grant execute on function public.create_unity_commission_adjustment(text, uuid, uuid, numeric, text, text) to service_role;
