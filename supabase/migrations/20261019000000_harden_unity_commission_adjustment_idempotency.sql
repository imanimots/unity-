-- ============================================================
-- Harden create_unity_commission_adjustment against duplicate
-- concurrent/replayed adjustment creation for SYSTEM-actor calls
-- (P5D-COMMISSION-REFUND-ADJUSTMENT-IDEMPOTENCY-I).
-- ============================================================
-- Root cause: this function already had an idempotency_keys-table-based
-- replay check (merchant_id/operation/idempotency_key), but that table's
-- merchant_id column is `not null references public.profiles(id)` --
-- genuinely incompatible with the automatic reconcile-refunds sweep,
-- which calls this RPC with p_actor_id = null (a 'system' actor, not an
-- admin profile). The function's own guard
-- (`if p_idempotency_key is not null and p_actor_id is not null`)
-- correctly reflects this constraint by skipping that table entirely
-- for system calls -- but that left the automatic sweep's adjustment
-- path with NO explicit database-level duplicate protection at all. The
-- only thing that made a duplicate adjustment rare in practice was
-- src/lib/commissions/reconcile.ts's own delta-based computation, which
-- is safe under SEQUENTIAL replay (a second run reads the already-
-- applied adjustment and computes delta = 0) but NOT under CONCURRENT
-- replay: two overlapping sweep runs can both read the same
-- pre-adjustment state, both compute the same non-zero delta, and both
-- attempt to insert it.
--
-- Fixed at the layer that was actually missing: unity_commission_adjustments
-- already had an `idempotency_key` column (unused by system calls, no
-- constraint on it at all) -- this migration adds a real partial unique
-- index on it and makes the INSERT itself the atomic claim boundary
-- (INSERT ... ON CONFLICT ... DO NOTHING RETURNING), the same pattern
-- this codebase already uses elsewhere (e.g. merchant_payouts_rtb_agreement_unique
-- + ON CONFLICT DO NOTHING in create_merchant_payout()). A losing
-- concurrent/replayed call returns the ALREADY-created adjustment's
-- result as a clean no-op -- never a second adjustment row, never a
-- second commission-state transition, never a second history row --
-- after first verifying the replay's material parameters
-- (commission_id/amount/reason) actually match the original request,
-- failing closed on a mismatch exactly like the existing
-- idempotency_keys-table path already does for admin callers.
--
-- The existing idempotency_keys-table check (for admin/non-null-actor
-- callers) is left completely untouched -- this is an ADDITIONAL,
-- independent safety net that now also covers the system-actor path the
-- original mechanism structurally could not reach, not a replacement.
-- Partial index (`where idempotency_key is not null`) means rows with no
-- key (e.g. any existing or future caller that doesn't supply one)
-- are completely unaffected -- no behavior change for those.
-- ============================================================

create unique index if not exists unity_commission_adjustments_idempotency_key_unique
  on public.unity_commission_adjustments(idempotency_key)
  where idempotency_key is not null;

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
  v_existing record;
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

  -- Existing admin-path replay check -- unchanged, still the authority
  -- for any caller that supplies a real actor_id.
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

  -- Atomic claim: the INSERT itself is the race-safe boundary. A
  -- concurrent/replayed call with the SAME idempotency_key loses the
  -- conflict and returns NULL here, never raising, never blocking past
  -- the winner's commit -- genuinely safe under concurrent execution,
  -- not just sequential retry. Rows with no key (p_idempotency_key is
  -- null) never conflict with anything, matching today's unconstrained
  -- behavior exactly.
  insert into public.unity_commission_adjustments (commission_id, amount, reason, created_by, idempotency_key)
  values (p_commission_id, p_amount, p_reason, p_actor_id, p_idempotency_key)
  on conflict (idempotency_key) where idempotency_key is not null do nothing
  returning id into v_adjustment_id;

  if v_adjustment_id is null and p_idempotency_key is not null then
    select id, commission_id, amount, reason into v_existing
    from public.unity_commission_adjustments
    where idempotency_key = p_idempotency_key;

    if v_existing.id is null then
      -- Should not happen (we just lost a conflict against this exact
      -- key), but never silently proceed if it somehow does.
      raise exception 'idempotency key conflict could not be resolved';
    end if;

    if v_existing.commission_id is distinct from p_commission_id
       or round(v_existing.amount, 2) is distinct from round(p_amount, 2)
       or v_existing.reason is distinct from p_reason then
      raise exception 'idempotency key already used with a different request';
    end if;

    select * into v_commission from public.unity_commissions where id = p_commission_id;
    return jsonb_build_object('commission_id', v_commission.id, 'adjustment_id', v_existing.id, 'status', v_commission.status, 'replay', true);
  end if;

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

revoke all on function public.create_unity_commission_adjustment(text, uuid, uuid, numeric, text, text) from public, anon, authenticated;
grant execute on function public.create_unity_commission_adjustment(text, uuid, uuid, numeric, text, text) to service_role;
