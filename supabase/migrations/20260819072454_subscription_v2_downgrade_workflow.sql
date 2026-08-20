-- ============================================================
-- Unity -- Merchant Subscription Tiers V2 -- downgrade consequence flow
--
-- Adds: a required downgrade reason (server-validated, not just a UI
-- field), a merchant-selected "keep set" of entities that remain active
-- when the target plan's cap is below current usage, and the canonical
-- REVERSIBLE (never destructive) deactivation mechanism per entity type,
-- executed idempotently by the existing lazy-sweep at effective time.
--
-- Deliberately distinct per entity type rather than one shared status,
-- because each table's own status model already differs (listings has
-- 'paused' as a general reversible state; barter_skill_task_posts only
-- has 'suspended' with a captured pre_suspend_status; marketplace_requests
-- has neither, so a new value is added) -- reusing what already exists
-- where it fits, adding the minimum new surface where it doesn't, never
-- overloading admin suspension/moderation with a second meaning.
-- ============================================================

-- ── profiles: business_name (Elite-only public branding), private by
-- default -- resolution of what's actually shown publicly happens in
-- application code (resolvePublicMerchantName), never a raw view column,
-- since it depends on the merchant's LIVE effective plan, not a static
-- per-row flag. Storing it here (not deleting it) is exactly what keeps
-- "legal/business data preserved privately" true across a downgrade. ──
alter table public.profiles add column if not exists business_name text;

-- Elite badge + business-name resolution, computed live in the view
-- itself (a LATERAL join against the same history-based resolution
-- effective-plan.ts uses) -- never a stored per-row flag that could go
-- stale or be spoofed, and no N+1 query on the application side: every
-- existing consumer of public_profiles (attachMerchantIdentities,
-- fetchPublicProfilesById, the public profile page) gets both new
-- columns for free by selecting them. is_elite/public_business_name are
-- always correct AT THE MOMENT OF READ, honoring downgrade timing
-- exactly like every other entitlement (Section 11: "the badge must not
-- permanently survive downgrade").
create or replace view public.public_profiles as
select
  p.id,
  p.display_name,
  p.full_name,
  p.avatar_url,
  p.role,
  (p.kyc_status = 'approved') as is_verified,
  p.unity_score,
  p.created_at,
  coalesce(plan.elite_badge_enabled, false) as is_elite,
  case when coalesce(plan.business_name_enabled, false) then p.business_name else null end as public_business_name
from public.profiles p
left join lateral (
  select msp.elite_badge_enabled, msp.business_name_enabled
  from public.merchant_subscription_plans msp
  where msp.id = coalesce(
    (
      select h.new_plan_id from public.merchant_subscription_history h
      where h.merchant_id = p.id and h.effective_at <= now()
      order by h.effective_at desc, h.created_at desc
      limit 1
    ),
    'starter'
  )
) plan on true;

grant select on public.public_profiles to anon, authenticated;

-- ── marketplace_requests: a new reversible, non-terminal status for
-- subscription-driven deactivation, distinct from owner-initiated
-- 'closed' (which is a deliberate end-of-life) and from 'archived'. ──
alter type marketplace_request_status add value if not exists 'deactivated';

-- ── barter_skill_task_posts: distinguishes WHY a post is 'suspended'
-- without adding a second overlapping status value. Backfills existing
-- suspended rows as admin-suspended (the only reason 'suspended' could
-- have existed before this migration). ──
alter table public.barter_skill_task_posts
  add column if not exists suspended_by text check (suspended_by is null or suspended_by in ('admin', 'subscription_downgrade'));
update public.barter_skill_task_posts set suspended_by = 'admin' where status = 'suspended' and suspended_by is null;

-- ============================================================
-- request_merchant_plan_change -- widened (genuine signature change:
-- DROP + CREATE, never a bare CREATE OR REPLACE over a different
-- parameter list, so no ambiguous overload becomes reachable via
-- PostgREST). Adds p_reason, required whenever the target plan ranks
-- LOWER than the current plan (covers both a downgrade to a lower paid
-- plan and a cancellation to Starter) -- never required for an upgrade.
-- All 3 existing named-JSON callers (upgrade/downgrade/cancel routes)
-- continue to work unchanged; only the downgrade/cancel routes are
-- updated (application layer) to actually pass a reason now.
-- ============================================================
drop function if exists public.request_merchant_plan_change(uuid, text, text, text);

create function public.request_merchant_plan_change(
  p_merchant_id uuid,
  p_target_plan_id text,
  p_billing_reference text default null,
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

  v_request_hash := md5(coalesce(p_merchant_id::text, '') || '|' || coalesce(p_target_plan_id, '') || '|' || coalesce(p_billing_reference, '') || '|' || coalesce(p_reason, ''));

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
    if p_reason is null or length(trim(p_reason)) = 0 then
      raise exception 'a reason is required to downgrade or cancel your plan';
    end if;

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

    -- A fresh downgrade request always clears any stale keep-set left
    -- over from a previous, since-cancelled downgrade request -- never
    -- silently reuse an old selection for a new target plan.
    delete from public.merchant_subscription_downgrade_keep_set where merchant_id = p_merchant_id;
  end if;

  insert into public.merchant_subscription_history
    (merchant_id, previous_plan_id, new_plan_id, requested_at, effective_at, actor_type, actor_id, change_category, reason, billing_reference, idempotency_key)
  values
    (p_merchant_id, v_current_plan_id, p_target_plan_id, now(), v_effective_at, 'merchant', p_merchant_id, v_category, p_reason, p_billing_reference, p_idempotency_key);

  v_result := to_jsonb(v_row);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_merchant_id, 'request_merchant_plan_change', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

revoke all on function public.request_merchant_plan_change(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.request_merchant_plan_change(uuid, text, text, text, text) to service_role;

-- ============================================================
-- KEEP-SET -- the merchant's confirmed choice of which entities stay
-- active when their target plan's cap is below current usage. Fully
-- replaceable before the downgrade's effective time (the merchant may
-- revisit their pending downgrade and change their mind); cleared
-- automatically whenever a fresh plan-change request is made (above).
-- ============================================================
create table if not exists public.merchant_subscription_downgrade_keep_set (
  id           uuid primary key default gen_random_uuid(),
  merchant_id  uuid not null references public.profiles(id),
  entity_type  text not null check (entity_type in ('listing', 'marketplace_request', 'barter_skill_task_post')),
  entity_id    uuid not null,
  created_at   timestamptz not null default now(),
  unique (merchant_id, entity_type, entity_id)
);

create index if not exists merchant_subscription_downgrade_keep_set_merchant_idx
  on public.merchant_subscription_downgrade_keep_set(merchant_id);

alter table public.merchant_subscription_downgrade_keep_set enable row level security;

create policy "merchant_subscription_downgrade_keep_set: own read"
  on public.merchant_subscription_downgrade_keep_set for select
  using (merchant_id = auth.uid());

create policy "merchant_subscription_downgrade_keep_set: admin read"
  on public.merchant_subscription_downgrade_keep_set for select
  using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));

-- Zero client write policies -- set_merchant_downgrade_keep_set() below is the only mutation path.

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
      select exists (select 1 from public.barter_skill_task_posts where id = v_entity_id and owner_id = p_merchant_id and status in ('active', 'offers_received') and is_test = false) into v_owned;
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

-- ============================================================
-- Per-entity-type reversible deactivate/reactivate -- the canonical,
-- non-destructive mechanism unselected excess entities move into at a
-- downgrade's effective time, and the merchant-facing way to bring
-- content back after a later upgrade (Section 85: never automatic).
-- ============================================================

-- Listings reuse the existing 'paused' status (a general merchant-
-- reversible state, previously unused by any RPC).
create or replace function public.merchant_pause_listing(p_merchant_id uuid, p_listing_id uuid, p_reason text default null, p_idempotency_key text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_listing record;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  select id, merchant_id, status into v_listing from public.listings where id = p_listing_id;
  if v_listing.id is null then raise exception 'listing not found'; end if;
  if v_listing.merchant_id <> p_merchant_id then raise exception 'you do not own this listing'; end if;
  if v_listing.status <> 'active' then raise exception 'only an active listing can be paused'; end if;

  update public.listings set status = 'paused' where id = p_listing_id;
  insert into public.listing_history (listing_id, changed_by, old_values, new_values, change_reason)
  values (p_listing_id, p_merchant_id, jsonb_build_object('listing_status', 'active'), jsonb_build_object('listing_status', 'paused'), coalesce(p_reason, 'merchant_paused'));

  return jsonb_build_object('listing_id', p_listing_id, 'status', 'paused');
end;
$$;

revoke all on function public.merchant_pause_listing(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.merchant_pause_listing(uuid, uuid, text, text) to service_role;

create or replace function public.merchant_resume_listing(p_merchant_id uuid, p_listing_id uuid, p_idempotency_key text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_listing record;
  v_active_count int;
  v_plan_id text;
  v_publication_limit int;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  select id, merchant_id, status, is_test into v_listing from public.listings where id = p_listing_id;
  if v_listing.id is null then raise exception 'listing not found'; end if;
  if v_listing.merchant_id <> p_merchant_id then raise exception 'you do not own this listing'; end if;
  if v_listing.status <> 'paused' then raise exception 'only a paused listing can be resumed'; end if;

  perform public._assert_not_publication_frozen(p_merchant_id);

  if not v_listing.is_test then
    v_active_count := public._lock_and_count_active_supply(p_merchant_id);
    v_plan_id := public._get_effective_merchant_plan_id(p_merchant_id);
    select active_publication_limit into v_publication_limit from public.merchant_subscription_plans where id = v_plan_id;
    if v_publication_limit is not null and v_active_count >= v_publication_limit then
      raise exception 'active_publication_limit_reached: the % plan allows up to % active published entities', v_plan_id, v_publication_limit;
    end if;
  end if;

  update public.listings set status = 'active' where id = p_listing_id;
  insert into public.listing_history (listing_id, changed_by, old_values, new_values, change_reason)
  values (p_listing_id, p_merchant_id, jsonb_build_object('listing_status', 'paused'), jsonb_build_object('listing_status', 'active'), 'merchant_resumed');

  return jsonb_build_object('listing_id', p_listing_id, 'status', 'active');
end;
$$;

revoke all on function public.merchant_resume_listing(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.merchant_resume_listing(uuid, uuid, text) to service_role;

-- Marketplace requests: the new 'deactivated' status.
create or replace function public._deactivate_marketplace_request(p_request_id uuid, p_actor_type text, p_actor_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_status marketplace_request_status;
begin
  select status into v_status from public.marketplace_requests where id = p_request_id for update;
  if v_status is null then raise exception 'request not found'; end if;
  if v_status not in ('active', 'offers_received') then raise exception 'request is in status % and cannot be deactivated', v_status; end if;

  update public.marketplace_requests set status = 'deactivated' where id = p_request_id;
  perform public._marketplace_request_history(p_request_id, null, p_actor_type, p_actor_id, 'deactivated', v_status::text, 'deactivated', jsonb_build_object('reason', p_reason));
end;
$$;
revoke all on function public._deactivate_marketplace_request(uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public._deactivate_marketplace_request(uuid, text, uuid, text) to service_role;

create or replace function public.merchant_reactivate_marketplace_request(p_actor_user_id uuid, p_request_id uuid, p_idempotency_key text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_request record;
  v_active_count int;
  v_plan_id text;
  v_publication_limit int;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  select * into v_request from public.marketplace_requests where id = p_request_id for update;
  if v_request.id is null then raise exception 'request not found'; end if;
  if v_request.requester_id <> p_actor_user_id then raise exception 'not the owner of this request'; end if;
  if v_request.status <> 'deactivated' then raise exception 'only a deactivated request can be reactivated from here'; end if;

  perform public._assert_not_publication_frozen(p_actor_user_id);

  if not v_request.is_test then
    v_active_count := public._lock_and_count_active_supply(p_actor_user_id);
    v_plan_id := public._get_effective_merchant_plan_id(p_actor_user_id);
    select active_publication_limit into v_publication_limit from public.merchant_subscription_plans where id = v_plan_id;
    if v_publication_limit is not null and v_active_count >= v_publication_limit then
      raise exception 'active_publication_limit_reached: the % plan allows up to % active published entities', v_plan_id, v_publication_limit;
    end if;
  end if;

  update public.marketplace_requests set status = 'active' where id = p_request_id;
  perform public._marketplace_request_history(p_request_id, null, 'requester', p_actor_user_id, 'reactivated', 'deactivated', 'active');

  return jsonb_build_object('request_id', p_request_id, 'status', 'active');
end;
$$;
revoke all on function public.merchant_reactivate_marketplace_request(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.merchant_reactivate_marketplace_request(uuid, uuid, text) to service_role;

-- Skill/Task posts: reuse 'suspended' + pre_suspend_status, tagged via
-- suspended_by so this is structurally distinguishable from an admin
-- moderation suspension (admin_restore_barter_skill_task_post refuses
-- to touch a subscription-deactivated row, and this reactivate RPC
-- refuses to touch an admin-suspended row -- two disjoint code paths
-- sharing one storage representation, never conflated at the API layer).
create or replace function public._deactivate_barter_skill_task_post(p_post_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_post public.barter_skill_task_posts;
begin
  select * into v_post from public.barter_skill_task_posts where id = p_post_id for update;
  if v_post is null then raise exception 'post not found'; end if;
  if v_post.status not in ('active', 'offers_received') then raise exception 'post is in status % and cannot be deactivated', v_post.status; end if;

  update public.barter_skill_task_posts
  set status = 'suspended', pre_suspend_status = v_post.status, suspended_by = 'subscription_downgrade'
  where id = p_post_id;

  insert into public.barter_skill_task_post_history (post_id, actor_user_id, actor_role, event_type, previous_status, new_status, reason)
  values (p_post_id, v_post.owner_id, 'system', 'post_suspended', v_post.status, 'suspended', p_reason);
end;
$$;
revoke all on function public._deactivate_barter_skill_task_post(uuid, text) from public, anon, authenticated;
grant execute on function public._deactivate_barter_skill_task_post(uuid, text) to service_role;

create or replace function public.merchant_reactivate_barter_skill_task_post(p_owner_id uuid, p_post_id uuid, p_idempotency_key text default null)
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
  values (p_post_id, p_owner_id, 'owner', 'post_restored', 'suspended', v_restore_status::text);

  return jsonb_build_object('post_id', p_post_id, 'status', v_restore_status);
end;
$$;
revoke all on function public.merchant_reactivate_barter_skill_task_post(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.merchant_reactivate_barter_skill_task_post(uuid, uuid, text) to service_role;

-- ============================================================
-- apply_due_merchant_subscription_changes -- widened to enforce the
-- keep-set at the moment a downgrade actually takes effect.
--
-- BINDING PRODUCT DECISION: Unity never auto-selects which of a
-- merchant's own listings/requests/posts stay active. If the confirmed
-- keep-set is missing or has become invalid (an item in it was closed/
-- deleted/no longer eligible) by the time the downgrade takes effect,
-- NOTHING is deactivated automatically. The plan change itself still
-- applies (the merchant's billing/entitlement terms honor the schedule
-- they agreed to), but the account is marked publication_frozen = true
-- -- every publish/reactivate RPC then refuses outright
-- (_assert_not_publication_frozen) until the merchant explicitly
-- resolves it via resolve_frozen_merchant_downgrade(). This is the
-- explicit intermediate state called for when auto-selection is
-- forbidden but the target plan must still become effective on
-- schedule.
-- ============================================================
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
  v_target_limit int;
  v_active_count int;
  v_keep_ids uuid[];
  v_needs_freeze boolean;
  v_excess record;
  v_deactivated_count int;
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
    v_deactivated_count := 0;
    v_needs_freeze := false;

    select active_publication_limit into v_target_limit
    from public.merchant_subscription_plans where id = v_row.pending_plan_id;

    if v_target_limit is not null then
      v_active_count := public._lock_and_count_active_supply(v_row.merchant_id);

      if v_active_count > v_target_limit then
        select coalesce(array_agg(entity_id), array[]::uuid[]) into v_keep_ids
        from public.merchant_subscription_downgrade_keep_set
        where merchant_id = v_row.merchant_id;

        -- The confirmed keep-set must exist AND still fit the target
        -- cap exactly as validated at selection time. If not, freeze --
        -- never guess on the merchant's behalf.
        if array_length(v_keep_ids, 1) is null or array_length(v_keep_ids, 1) > v_target_limit then
          v_needs_freeze := true;
        else
          for v_excess in
            (
              select 'listing' as entity_type, id as entity_id from public.listings
              where merchant_id = v_row.merchant_id and status = 'active' and is_test = false and id <> all(v_keep_ids)
              union all
              select 'barter_skill_task_post', id from public.barter_skill_task_posts
              where owner_id = v_row.merchant_id and status in ('active', 'offers_received') and is_test = false and id <> all(v_keep_ids)
              union all
              select 'marketplace_request', id from public.marketplace_requests
              where requester_id = v_row.merchant_id and status in ('active', 'offers_received') and is_test = false and id <> all(v_keep_ids)
            )
          loop
            if v_excess.entity_type = 'listing' then
              update public.listings set status = 'paused' where id = v_excess.entity_id;
              insert into public.listing_history (listing_id, changed_by, old_values, new_values, change_reason)
              values (v_excess.entity_id, null, jsonb_build_object('listing_status', 'active'), jsonb_build_object('listing_status', 'paused'), 'subscription_downgrade_keep_set');
            elsif v_excess.entity_type = 'marketplace_request' then
              perform public._deactivate_marketplace_request(v_excess.entity_id, 'system', null, 'subscription_downgrade_keep_set');
            else
              perform public._deactivate_barter_skill_task_post(v_excess.entity_id, 'subscription_downgrade_keep_set');
            end if;
            v_deactivated_count := v_deactivated_count + 1;
          end loop;
        end if;
      end if;
    end if;

    delete from public.merchant_subscription_downgrade_keep_set where merchant_id = v_row.merchant_id;

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
      last_transition_category = v_category,
      publication_frozen = v_needs_freeze
    where id = v_row.id;

    v_applied := v_applied || jsonb_build_object(
      'merchantId', v_row.merchant_id,
      'previousPlanId', v_row.current_plan_id,
      'newPlanId', v_row.pending_plan_id,
      'changeCategory', v_category,
      'deactivatedCount', v_deactivated_count,
      'publicationFrozen', v_needs_freeze
    );
  end loop;

  return jsonb_build_object('applied', v_applied, 'count', jsonb_array_length(v_applied));
end;
$$;

revoke all on function public.apply_due_merchant_subscription_changes() from public, anon, authenticated;
grant execute on function public.apply_due_merchant_subscription_changes() to service_role;

-- ────────────────────────────────────────────────────────────
-- resolve_frozen_merchant_downgrade -- the ONLY way publication_frozen
-- clears. This is the merchant explicitly choosing, right now, which
-- currently-active entities remain active -- never an autonomous
-- system choice, even though it runs after the effective date.
-- ────────────────────────────────────────────────────────────
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
      select exists (select 1 from public.barter_skill_task_posts where id = v_entity_id and owner_id = p_merchant_id and status in ('active', 'offers_received') and is_test = false) into v_owned;
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
      where owner_id = p_merchant_id and status in ('active', 'offers_received') and is_test = false and id <> all(v_keep_ids)
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
