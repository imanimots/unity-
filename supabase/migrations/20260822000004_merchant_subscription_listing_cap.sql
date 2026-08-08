-- ============================================================
-- Unity Phase 1 -- Merchant Subscriptions & Economics
-- Starter's active-listing cap, enforced at the one real activation
-- gate (activate_listing -- covers both first-time moderation approval
-- and re-activating a suspended listing; nothing else ever flips a
-- listing to 'active'). Blocks NEW activation only -- never touches an
-- already-active listing, so an existing over-the-cap merchant is
-- grandfathered automatically by construction (their existing rows are
-- simply never revisited by this check).
--
-- Test/QA fixture listings (is_test = true) are excluded entirely, both
-- as something the cap counts against AND as something the cap is ever
-- enforced on -- regression scripts routinely exceed 5 listings per QA
-- merchant today (up to 80, confirmed live) and must keep working
-- unmodified.
-- ============================================================

-- ─────────────────────────────────────────
-- _get_effective_merchant_plan_id -- the SQL-side mirror of
-- src/lib/subscriptions/effective-plan.ts's current-time resolution
-- (Postgres can't call out to the TS implementation, so the same small
-- piece of logic is necessarily expressed once in each runtime; both
-- read the same two tables, so rates/data can never drift, only the
-- resolution logic is duplicated, and deliberately kept tiny for
-- exactly that reason).
-- ─────────────────────────────────────────
create or replace function public._get_effective_merchant_plan_id(p_merchant_id uuid)
returns text
language plpgsql
stable
as $$
declare
  v_row public.merchant_subscriptions;
begin
  select * into v_row from public.merchant_subscriptions where merchant_id = p_merchant_id;

  if v_row is null then
    return 'starter';
  end if;

  if v_row.pending_plan_effective_at is not null and v_row.pending_plan_effective_at <= now() then
    return v_row.pending_plan_id;
  end if;

  return v_row.current_plan_id;
end;
$$;

create or replace function public.activate_listing(
  p_listing_id uuid,
  p_admin_id uuid,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_request_hash text;
  v_idem record;
  v_listing_status listing_status;
  v_moderation_status moderation_status;
  v_merchant_id uuid;
  v_is_test boolean;
  v_plan_id text;
  v_listing_limit integer;
  v_active_count integer;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_admin_id is null then
    raise exception 'not authenticated';
  end if;

  v_request_hash := md5(coalesce(p_listing_id::text, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_admin_id and operation = 'activate_listing' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select status, merchant_id, is_test into v_listing_status, v_merchant_id, v_is_test
  from public.listings where id = p_listing_id;
  if v_listing_status is null then
    raise exception 'listing not found';
  end if;
  if v_listing_status not in ('pending', 'suspended') then
    raise exception 'listing status "%" is not eligible for activation', v_listing_status;
  end if;

  select moderation_status into v_moderation_status
  from public.listing_moderation where listing_id = p_listing_id;

  if v_moderation_status is distinct from 'approved' then
    raise exception 'listing has not been approved by moderation';
  end if;

  -- Starter active-listing cap -- real listings only, never test fixtures.
  if not v_is_test then
    v_plan_id := public._get_effective_merchant_plan_id(v_merchant_id);
    select active_listing_limit into v_listing_limit from public.merchant_subscription_plans where id = v_plan_id;

    if v_listing_limit is not null then
      select count(*) into v_active_count
      from public.listings
      where merchant_id = v_merchant_id
        and status = 'active'
        and is_test = false
        and id <> p_listing_id;

      if v_active_count >= v_listing_limit then
        raise exception 'active_listing_limit_reached: the % plan allows up to % active listings', v_plan_id, v_listing_limit;
      end if;
    end if;
  end if;

  update public.listings set status = 'active' where id = p_listing_id;

  insert into public.listing_history (listing_id, changed_by, old_values, new_values, change_reason)
  values (
    p_listing_id, p_admin_id,
    jsonb_build_object('listing_status', v_listing_status),
    jsonb_build_object('listing_status', 'active'),
    'listing_activated'
  );

  insert into public.admin_action_history (listing_id, action_type, admin_id, previous_status, new_status)
  values (p_listing_id, 'listing_activated', p_admin_id, v_listing_status::text, 'active');

  v_result := jsonb_build_object('listing_id', p_listing_id, 'status', 'active');

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_admin_id, 'activate_listing', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;
