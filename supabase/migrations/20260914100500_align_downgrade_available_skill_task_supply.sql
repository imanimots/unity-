-- ============================================================
-- Fix-forward: align the Subscription V2 downgrade workflow's
-- Skill/Task entitlement predicate with the current canonical rule
-- (direction = 'available' AND status = 'active' AND is_test = false).
--
-- Both functions below still used the pre-direction-filter predicate
-- (status IN ('active','offers_received')) from before Available/
-- Looking-For posts existed as distinct concepts. A Looking-For post
-- can never legitimately consume a publication slot -- it never counts
-- toward the cap in _lock_and_count_active_supply -- so it must not be
-- acceptable as a downgrade keep-set entity, nor eligible for excess
-- (auto-deactivation) selection either. This restores that invariant.
--
-- Everything else in both function bodies (idempotency, listing
-- handling, marketplace_request handling, history, error semantics,
-- security mode, search_path, grants) is copied byte-for-byte
-- unchanged from the current live definitions in
-- 20260819072454_subscription_v2_downgrade_workflow.sql. No other
-- function is touched by this migration.
-- ============================================================

create or replace function public.set_merchant_downgrade_keep_set(
  p_merchant_id uuid,
  p_entities jsonb,
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
  v_row public.merchant_subscriptions;
  v_target_limit int;
  v_entity jsonb;
  v_entity_type text;
  v_entity_id uuid;
  v_owned boolean;
  v_count int := 0;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_merchant_id is null then
    raise exception 'merchant id is required';
  end if;
  if p_entities is null or jsonb_typeof(p_entities) <> 'array' then
    raise exception 'entities must be a JSON array';
  end if;

  v_request_hash := md5(coalesce(p_merchant_id::text, '') || '|' || p_entities::text);
  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_merchant_id and operation = 'set_merchant_downgrade_keep_set' and idempotency_key = p_idempotency_key;
    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select * into v_row from public.merchant_subscriptions where merchant_id = p_merchant_id for update;
  if v_row is null or v_row.status not in ('pending_change', 'cancelled') then
    raise exception 'no pending downgrade to select a keep-set for';
  end if;

  select active_publication_limit into v_target_limit
  from public.merchant_subscription_plans where id = v_row.pending_plan_id;

  if v_target_limit is not null and jsonb_array_length(p_entities) > v_target_limit then
    raise exception 'keep_set_exceeds_target_cap: you selected % entities but the % plan allows up to %', jsonb_array_length(p_entities), v_row.pending_plan_id, v_target_limit;
  end if;

  for v_entity in select * from jsonb_array_elements(p_entities)
  loop
    v_entity_type := v_entity->>'entityType';
    v_entity_id := (v_entity->>'entityId')::uuid;

    if v_entity_type not in ('listing', 'marketplace_request', 'barter_skill_task_post') then
      raise exception 'invalid entity type in keep set: %', v_entity_type;
    end if;

    if v_entity_type = 'listing' then
      select exists (select 1 from public.listings where id = v_entity_id and merchant_id = p_merchant_id and status = 'active' and is_test = false) into v_owned;
    elsif v_entity_type = 'marketplace_request' then
      select exists (select 1 from public.marketplace_requests where id = v_entity_id and requester_id = p_merchant_id and status in ('active', 'offers_received') and is_test = false) into v_owned;
    else
      select exists (select 1 from public.barter_skill_task_posts where id = v_entity_id and owner_id = p_merchant_id and direction = 'available' and status = 'active' and is_test = false) into v_owned;
    end if;

    if not v_owned then
      raise exception 'keep_set_entity_invalid: entity % (%) is not your own currently-active published content', v_entity_id, v_entity_type;
    end if;

    v_count := v_count + 1;
  end loop;

  delete from public.merchant_subscription_downgrade_keep_set where merchant_id = p_merchant_id;

  insert into public.merchant_subscription_downgrade_keep_set (merchant_id, entity_type, entity_id)
  select p_merchant_id, e->>'entityType', (e->>'entityId')::uuid
  from jsonb_array_elements(p_entities) as e;

  v_result := jsonb_build_object('merchant_id', p_merchant_id, 'kept_count', v_count);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_merchant_id, 'set_merchant_downgrade_keep_set', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

revoke all on function public.set_merchant_downgrade_keep_set(uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.set_merchant_downgrade_keep_set(uuid, jsonb, text) to service_role;

create or replace function public.resolve_frozen_merchant_downgrade(
  p_merchant_id uuid,
  p_entities jsonb,
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
  v_row public.merchant_subscriptions;
  v_target_limit int;
  v_entity jsonb;
  v_entity_type text;
  v_entity_id uuid;
  v_owned boolean;
  v_keep_ids uuid[] := array[]::uuid[];
  v_excess record;
  v_deactivated_count int := 0;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_merchant_id is null then
    raise exception 'merchant id is required';
  end if;
  if p_entities is null or jsonb_typeof(p_entities) <> 'array' then
    raise exception 'entities must be a JSON array';
  end if;

  v_request_hash := md5(coalesce(p_merchant_id::text, '') || '|' || p_entities::text);
  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_merchant_id and operation = 'resolve_frozen_merchant_downgrade' and idempotency_key = p_idempotency_key;
    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select * into v_row from public.merchant_subscriptions where merchant_id = p_merchant_id for update;
  if v_row is null or not v_row.publication_frozen then
    raise exception 'no frozen downgrade to resolve';
  end if;

  select active_publication_limit into v_target_limit
  from public.merchant_subscription_plans where id = v_row.current_plan_id;

  if v_target_limit is not null and jsonb_array_length(p_entities) > v_target_limit then
    raise exception 'keep_set_exceeds_target_cap: you selected % entities but the % plan allows up to %', jsonb_array_length(p_entities), v_row.current_plan_id, v_target_limit;
  end if;

  for v_entity in select * from jsonb_array_elements(p_entities)
  loop
    v_entity_type := v_entity->>'entityType';
    v_entity_id := (v_entity->>'entityId')::uuid;

    if v_entity_type not in ('listing', 'marketplace_request', 'barter_skill_task_post') then
      raise exception 'invalid entity type in keep set: %', v_entity_type;
    end if;

    if v_entity_type = 'listing' then
      select exists (select 1 from public.listings where id = v_entity_id and merchant_id = p_merchant_id and status = 'active' and is_test = false) into v_owned;
    elsif v_entity_type = 'marketplace_request' then
      select exists (select 1 from public.marketplace_requests where id = v_entity_id and requester_id = p_merchant_id and status in ('active', 'offers_received') and is_test = false) into v_owned;
    else
      select exists (select 1 from public.barter_skill_task_posts where id = v_entity_id and owner_id = p_merchant_id and direction = 'available' and status = 'active' and is_test = false) into v_owned;
    end if;

    if not v_owned then
      raise exception 'keep_set_entity_invalid: entity % (%) is not your own currently-active published content', v_entity_id, v_entity_type;
    end if;

    v_keep_ids := v_keep_ids || v_entity_id;
  end loop;

  for v_excess in
    (
      select 'listing' as entity_type, id as entity_id from public.listings
      where merchant_id = p_merchant_id and status = 'active' and is_test = false and id <> all(v_keep_ids)
      union all
      select 'barter_skill_task_post', id from public.barter_skill_task_posts
      where owner_id = p_merchant_id and direction = 'available' and status = 'active' and is_test = false and id <> all(v_keep_ids)
      union all
      select 'marketplace_request', id from public.marketplace_requests
      where requester_id = p_merchant_id and status in ('active', 'offers_received') and is_test = false and id <> all(v_keep_ids)
    )
  loop
    if v_excess.entity_type = 'listing' then
      update public.listings set status = 'paused' where id = v_excess.entity_id;
      insert into public.listing_history (listing_id, changed_by, old_values, new_values, change_reason)
      values (v_excess.entity_id, p_merchant_id, jsonb_build_object('listing_status', 'active'), jsonb_build_object('listing_status', 'paused'), 'subscription_downgrade_keep_set_resolved');
    elsif v_excess.entity_type = 'marketplace_request' then
      perform public._deactivate_marketplace_request(v_excess.entity_id, 'requester', p_merchant_id, 'subscription_downgrade_keep_set_resolved');
    else
      perform public._deactivate_barter_skill_task_post(v_excess.entity_id, 'subscription_downgrade_keep_set_resolved');
    end if;
    v_deactivated_count := v_deactivated_count + 1;
  end loop;

  update public.merchant_subscriptions set publication_frozen = false where merchant_id = p_merchant_id;

  v_result := jsonb_build_object('merchant_id', p_merchant_id, 'kept_count', jsonb_array_length(p_entities), 'deactivated_count', v_deactivated_count, 'publication_frozen', false);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_merchant_id, 'resolve_frozen_merchant_downgrade', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

revoke all on function public.resolve_frozen_merchant_downgrade(uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.resolve_frozen_merchant_downgrade(uuid, jsonb, text) to service_role;
