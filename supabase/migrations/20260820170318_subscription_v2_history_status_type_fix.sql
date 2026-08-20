-- ============================================================
-- Fix-forward: admin_restore_barter_skill_task_post and
-- merchant_reactivate_barter_skill_task_post both insert
-- v_restore_status::text into barter_skill_task_post_history.new_status,
-- a real barter_skill_task_post_status enum column, not text. The
-- explicit ::text cast defeats Postgres's usual implicit
-- literal/enum coercion (every other status insert in this codebase
-- passes an enum-typed column or literal directly, uncast, and works
-- fine) and fails with "column new_status is of type
-- barter_skill_task_post_status but expression is of type text null"
-- the first time either function actually runs against a real post
-- live. Discovered by running verify-skills-tasks-barter.mjs against
-- the newly-applied V2 schema. Fix: drop the cast, matching every
-- other insert into this same table/column in this codebase.
-- ============================================================

create or replace function public.admin_restore_barter_skill_task_post(
  p_admin_id uuid, p_post_id uuid, p_reason text, p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request_hash text;
  v_idem record;
  v_post public.barter_skill_task_posts;
  v_restore_status barter_skill_task_post_status;
  v_active_count int;
  v_plan_id text;
  v_publication_limit int;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_admin_id is null then
    raise exception 'admin id is required';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a reason is required to restore a suspended post';
  end if;

  v_request_hash := md5(coalesce(p_post_id::text, ''));
  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_admin_id and operation = 'admin_restore_barter_skill_task_post' and idempotency_key = p_idempotency_key;
    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select * into v_post from public.barter_skill_task_posts where id = p_post_id for update;
  if v_post is null then
    raise exception 'post not found';
  end if;
  if v_post.status <> 'suspended' then
    raise exception 'only a suspended post can be restored';
  end if;
  if v_post.pre_suspend_status is null or v_post.pre_suspend_status not in ('active', 'paused', 'offers_received') then
    raise exception 'this post has no valid restorable prior status';
  end if;

  v_restore_status := v_post.pre_suspend_status;

  if v_restore_status in ('active', 'offers_received') then
    perform public._assert_not_publication_frozen(v_post.owner_id);
  end if;

  if v_restore_status in ('active', 'offers_received') and not v_post.is_test then
    v_active_count := public._lock_and_count_active_supply(v_post.owner_id);
    v_plan_id := public._get_effective_merchant_plan_id(v_post.owner_id);
    select active_publication_limit into v_publication_limit from public.merchant_subscription_plans where id = v_plan_id;
    if v_publication_limit is not null and v_active_count >= v_publication_limit then
      raise exception 'active_publication_limit_reached: restoring this post would exceed the % plan''s current allowance of % active published entities', v_plan_id, v_publication_limit;
    end if;
  end if;

  update public.barter_skill_task_posts
  set status = v_restore_status, pre_suspend_status = null
  where id = p_post_id;

  insert into public.barter_skill_task_post_history (post_id, actor_user_id, actor_role, event_type, previous_status, new_status, reason)
  values (p_post_id, p_admin_id, 'admin', 'post_restored', 'suspended', v_restore_status, p_reason);

  v_result := jsonb_build_object('post_id', p_post_id, 'status', v_restore_status);
  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_admin_id, 'admin_restore_barter_skill_task_post', p_idempotency_key, v_request_hash, v_result);
  end if;
  return v_result;
end;
$$;

create or replace function public.merchant_reactivate_barter_skill_task_post(
  p_owner_id uuid, p_post_id uuid, p_idempotency_key text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_post public.barter_skill_task_posts;
  v_restore_status barter_skill_task_post_status;
  v_active_count int;
  v_plan_id text;
  v_publication_limit int;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  select * into v_post from public.barter_skill_task_posts where id = p_post_id for update;
  if v_post is null or v_post.owner_id <> p_owner_id then raise exception 'post not found or not owned by caller'; end if;
  if v_post.status <> 'suspended' or v_post.suspended_by <> 'subscription_downgrade' then
    raise exception 'only a subscription-deactivated post can be reactivated from here';
  end if;

  v_restore_status := coalesce(v_post.pre_suspend_status, 'active');

  perform public._assert_not_publication_frozen(p_owner_id);

  if not v_post.is_test then
    v_active_count := public._lock_and_count_active_supply(p_owner_id);
    v_plan_id := public._get_effective_merchant_plan_id(p_owner_id);
    select active_publication_limit into v_publication_limit from public.merchant_subscription_plans where id = v_plan_id;
    if v_publication_limit is not null and v_active_count >= v_publication_limit then
      raise exception 'active_publication_limit_reached: the % plan allows up to % active published entities', v_plan_id, v_publication_limit;
    end if;
  end if;

  update public.barter_skill_task_posts
  set status = v_restore_status, pre_suspend_status = null, suspended_by = null
  where id = p_post_id;

  insert into public.barter_skill_task_post_history (post_id, actor_user_id, actor_role, event_type, previous_status, new_status)
  values (p_post_id, p_owner_id, 'owner', 'post_restored', 'suspended', v_restore_status);

  return jsonb_build_object('post_id', p_post_id, 'status', v_restore_status);
end;
$$;
