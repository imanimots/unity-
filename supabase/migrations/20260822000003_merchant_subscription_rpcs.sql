-- ============================================================
-- Unity Phase 1 -- Merchant Subscriptions & Economics
-- Lifecycle RPCs. All security definer, service-role-only, actor id
-- always an explicit parameter never auth.uid(). Idempotency via the
-- standard idempotency_keys table where a single merchant is the
-- actor; apply_due_merchant_subscription_changes() is a system-wide
-- sweep and is idempotent by construction (its own WHERE clause finds
-- nothing left to do on a harmless re-run), matching
-- expire_stale_barter_proposals()'s precedent exactly.
-- ============================================================

-- ─────────────────────────────────────────
-- request_merchant_plan_change
-- Merchant-initiated upgrade (immediate, requires proof of a
-- successful mock billing attempt) or downgrade/cancellation
-- (scheduled one month out, never immediate -- the merchant already
-- paid for the current period).
-- ─────────────────────────────────────────
create or replace function public.request_merchant_plan_change(
  p_merchant_id uuid,
  p_target_plan_id text,
  p_billing_reference text default null,
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
  v_result jsonb;
  v_row public.merchant_subscriptions;
  v_current_plan_id text;
  v_current_rank smallint;
  v_target_rank smallint;
  v_target_active boolean;
  v_effective_at timestamptz;
  v_category text;
  v_status text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_merchant_id is null then
    raise exception 'merchant id is required';
  end if;

  v_request_hash := md5(coalesce(p_merchant_id::text, '') || '|' || coalesce(p_target_plan_id, '') || '|' || coalesce(p_billing_reference, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_merchant_id and operation = 'request_merchant_plan_change' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select plan_rank, is_active into v_target_rank, v_target_active
    from public.merchant_subscription_plans where id = p_target_plan_id;
  if not found then
    raise exception 'unknown plan: %', p_target_plan_id;
  end if;
  if not v_target_active then
    raise exception 'plan % is not currently available', p_target_plan_id;
  end if;

  select * into v_row from public.merchant_subscriptions where merchant_id = p_merchant_id for update;

  v_current_plan_id := coalesce(v_row.current_plan_id, 'starter');
  select plan_rank into v_current_rank from public.merchant_subscription_plans where id = v_current_plan_id;

  if p_target_plan_id = v_current_plan_id then
    raise exception 'merchant is already on plan % -- use cancel_pending_merchant_plan_change to undo a scheduled change instead', p_target_plan_id;
  end if;

  if v_target_rank > v_current_rank then
    -- Upgrade -- immediate, requires a successful mock billing attempt already recorded by the caller.
    if p_billing_reference is null then
      raise exception 'a successful billing reference is required to upgrade';
    end if;
    v_effective_at := now();
    v_category := 'upgrade';
    v_status := 'active';

    insert into public.merchant_subscriptions (merchant_id, current_plan_id, current_plan_effective_at, pending_plan_id, pending_plan_effective_at, status, last_transition_category)
    values (p_merchant_id, p_target_plan_id, v_effective_at, null, null, v_status, v_category)
    on conflict (merchant_id) do update set
      current_plan_id = excluded.current_plan_id,
      current_plan_effective_at = excluded.current_plan_effective_at,
      pending_plan_id = null,
      pending_plan_effective_at = null,
      status = excluded.status,
      last_transition_category = excluded.last_transition_category
    returning * into v_row;
  else
    -- Downgrade to a lower paid plan, or cancellation (target = starter) -- always scheduled, never immediate.
    v_effective_at := now() + interval '1 month';
    v_category := case when p_target_plan_id = 'starter' then 'cancellation' else 'downgrade' end;
    v_status := case when p_target_plan_id = 'starter' then 'cancelled' else 'pending_change' end;

    insert into public.merchant_subscriptions (merchant_id, current_plan_id, current_plan_effective_at, pending_plan_id, pending_plan_effective_at, status, last_transition_category)
    values (p_merchant_id, v_current_plan_id, coalesce(v_row.current_plan_effective_at, now()), p_target_plan_id, v_effective_at, v_status, v_category)
    on conflict (merchant_id) do update set
      pending_plan_id = excluded.pending_plan_id,
      pending_plan_effective_at = excluded.pending_plan_effective_at,
      status = excluded.status,
      last_transition_category = excluded.last_transition_category
    returning * into v_row;
  end if;

  insert into public.merchant_subscription_history
    (merchant_id, previous_plan_id, new_plan_id, requested_at, effective_at, actor_type, actor_id, change_category, billing_reference, idempotency_key)
  values
    (p_merchant_id, v_current_plan_id, p_target_plan_id, now(), v_effective_at, 'merchant', p_merchant_id, v_category, p_billing_reference, p_idempotency_key);

  v_result := to_jsonb(v_row);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_merchant_id, 'request_merchant_plan_change', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

revoke all on function public.request_merchant_plan_change(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.request_merchant_plan_change(uuid, text, text, text) to service_role;

-- ─────────────────────────────────────────
-- cancel_pending_merchant_plan_change
-- Reverts a scheduled downgrade/cancellation back to the current plan,
-- staying active. Requires a genuine pending change to exist.
-- ─────────────────────────────────────────
create or replace function public.cancel_pending_merchant_plan_change(
  p_merchant_id uuid,
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
  v_result jsonb;
  v_row public.merchant_subscriptions;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_merchant_id is null then
    raise exception 'merchant id is required';
  end if;

  v_request_hash := md5(coalesce(p_merchant_id::text, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_merchant_id and operation = 'cancel_pending_merchant_plan_change' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select * into v_row from public.merchant_subscriptions where merchant_id = p_merchant_id for update;

  if v_row is null or v_row.status not in ('pending_change', 'cancelled') then
    raise exception 'no pending plan change to cancel';
  end if;

  insert into public.merchant_subscription_history
    (merchant_id, previous_plan_id, new_plan_id, requested_at, effective_at, actor_type, actor_id, change_category, idempotency_key)
  values
    (p_merchant_id, v_row.pending_plan_id, v_row.current_plan_id, now(), now(), 'merchant', p_merchant_id, 'pending_change_cancelled', p_idempotency_key);

  update public.merchant_subscriptions set
    pending_plan_id = null,
    pending_plan_effective_at = null,
    status = 'active',
    last_transition_category = 'pending_change_cancelled'
  where merchant_id = p_merchant_id
  returning * into v_row;

  v_result := to_jsonb(v_row);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_merchant_id, 'cancel_pending_merchant_plan_change', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

revoke all on function public.cancel_pending_merchant_plan_change(uuid, text) from public, anon, authenticated;
grant execute on function public.cancel_pending_merchant_plan_change(uuid, text) to service_role;

-- ─────────────────────────────────────────
-- apply_due_merchant_subscription_changes
-- Lazy-sweep, mirrors expire_stale_barter_proposals(): finds every
-- subscription whose scheduled change is now due and applies it,
-- writing a second, system-actor history row (the first row, written
-- at request time, already recorded the merchant's original request).
-- Returns the list of merchants affected so the caller can dispatch
-- "your plan changed" notifications.
-- ─────────────────────────────────────────
create or replace function public.apply_due_merchant_subscription_changes()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_applied jsonb := '[]'::jsonb;
  v_row record;
  v_category text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;

  for v_row in
    select * from public.merchant_subscriptions
    where status in ('pending_change', 'cancelled')
      and pending_plan_effective_at <= now()
    for update
  loop
    v_category := case when v_row.pending_plan_id = 'starter' then 'reversion' else 'downgrade' end;

    insert into public.merchant_subscription_history
      (merchant_id, previous_plan_id, new_plan_id, requested_at, effective_at, actor_type, actor_id, change_category)
    values
      (v_row.merchant_id, v_row.current_plan_id, v_row.pending_plan_id, now(), now(), 'system', null, v_category);

    update public.merchant_subscriptions set
      current_plan_id = v_row.pending_plan_id,
      current_plan_effective_at = v_row.pending_plan_effective_at,
      pending_plan_id = null,
      pending_plan_effective_at = null,
      status = 'active',
      last_transition_category = v_category
    where id = v_row.id;

    v_applied := v_applied || jsonb_build_object(
      'merchantId', v_row.merchant_id,
      'previousPlanId', v_row.current_plan_id,
      'newPlanId', v_row.pending_plan_id,
      'changeCategory', v_category
    );
  end loop;

  return jsonb_build_object('applied', v_applied, 'count', jsonb_array_length(v_applied));
end;
$$;

revoke all on function public.apply_due_merchant_subscription_changes() from public, anon, authenticated;
grant execute on function public.apply_due_merchant_subscription_changes() to service_role;

-- ─────────────────────────────────────────
-- admin_correct_merchant_subscription
-- A narrow, reason-required admin override. Never charges, never
-- rewrites history -- appends a new admin_correction row.
-- ─────────────────────────────────────────
create or replace function public.admin_correct_merchant_subscription(
  p_admin_id uuid,
  p_merchant_id uuid,
  p_new_plan_id text,
  p_immediate boolean,
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
  v_result jsonb;
  v_row public.merchant_subscriptions;
  v_current_plan_id text;
  v_target_active boolean;
  v_effective_at timestamptz;
  v_status text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_admin_id is null then
    raise exception 'admin id is required';
  end if;
  if p_merchant_id is null then
    raise exception 'merchant id is required';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a reason is required for an administrative correction';
  end if;

  v_request_hash := md5(coalesce(p_merchant_id::text, '') || '|' || coalesce(p_new_plan_id, '') || '|' || p_immediate::text);

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_admin_id and operation = 'admin_correct_merchant_subscription' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select is_active into v_target_active from public.merchant_subscription_plans where id = p_new_plan_id;
  if not found then
    raise exception 'unknown plan: %', p_new_plan_id;
  end if;

  select * into v_row from public.merchant_subscriptions where merchant_id = p_merchant_id for update;
  v_current_plan_id := coalesce(v_row.current_plan_id, 'starter');

  if p_immediate then
    v_effective_at := now();
    v_status := 'active';
    insert into public.merchant_subscriptions (merchant_id, current_plan_id, current_plan_effective_at, pending_plan_id, pending_plan_effective_at, status, last_transition_category)
    values (p_merchant_id, p_new_plan_id, v_effective_at, null, null, v_status, 'admin_correction')
    on conflict (merchant_id) do update set
      current_plan_id = excluded.current_plan_id,
      current_plan_effective_at = excluded.current_plan_effective_at,
      pending_plan_id = null,
      pending_plan_effective_at = null,
      status = excluded.status,
      last_transition_category = excluded.last_transition_category
    returning * into v_row;
  else
    v_effective_at := now() + interval '1 month';
    v_status := 'pending_change';
    insert into public.merchant_subscriptions (merchant_id, current_plan_id, current_plan_effective_at, pending_plan_id, pending_plan_effective_at, status, last_transition_category)
    values (p_merchant_id, v_current_plan_id, coalesce(v_row.current_plan_effective_at, now()), p_new_plan_id, v_effective_at, v_status, 'admin_correction')
    on conflict (merchant_id) do update set
      pending_plan_id = excluded.pending_plan_id,
      pending_plan_effective_at = excluded.pending_plan_effective_at,
      status = excluded.status,
      last_transition_category = excluded.last_transition_category
    returning * into v_row;
  end if;

  insert into public.merchant_subscription_history
    (merchant_id, previous_plan_id, new_plan_id, requested_at, effective_at, actor_type, actor_id, change_category, reason, idempotency_key)
  values
    (p_merchant_id, v_current_plan_id, p_new_plan_id, now(), v_effective_at, 'admin', p_admin_id, 'admin_correction', p_reason, p_idempotency_key);

  v_result := to_jsonb(v_row);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_admin_id, 'admin_correct_merchant_subscription', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

revoke all on function public.admin_correct_merchant_subscription(uuid, uuid, text, boolean, text, text) from public, anon, authenticated;
grant execute on function public.admin_correct_merchant_subscription(uuid, uuid, text, boolean, text, text) to service_role;
