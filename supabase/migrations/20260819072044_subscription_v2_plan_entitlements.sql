-- ============================================================
-- Unity -- Merchant Subscription Tiers V2
--
-- Replaces the Phase 1 listing-only cap with a GLOBAL active-publication
-- cap counted once per canonical entity (listings, marketplace_requests,
-- barter_skill_task_posts) regardless of how many modes an entity
-- supports. Adds the full V2 entitlement matrix as new columns on the
-- ONE authoritative plan-catalogue table -- every consumer still reads
-- rates/limits from merchant_subscription_plans, nothing hardcoded a
-- second time. Prices and commission rates are UNCHANGED (binding).
--
-- Column rename: active_listing_limit -> active_publication_limit,
-- reflecting that it now gates a combined cross-table count, not just
-- listings. Every SQL/TS consumer is updated in this same phase.
-- ============================================================

alter table public.merchant_subscription_plans
  rename column active_listing_limit to active_publication_limit;

alter table public.merchant_subscription_plans
  add column if not exists advertising_discount_bps integer not null default 0 check (advertising_discount_bps between 0 and 10000),
  add column if not exists affiliate_enabled boolean not null default false,
  add column if not exists analytics_level text not null default 'basic' check (analytics_level in ('basic', 'full')),
  add column if not exists demand_insights_enabled boolean not null default false,
  add column if not exists listing_assistant_enabled boolean not null default false,
  add column if not exists analytics_assistant_enabled boolean not null default false,
  add column if not exists advanced_tools_enabled boolean not null default false,
  add column if not exists support_level text not null default 'standard' check (support_level in ('standard', 'priority', 'highest')),
  add column if not exists business_name_enabled boolean not null default false,
  add column if not exists elite_badge_enabled boolean not null default false;

update public.merchant_subscription_plans set
  active_publication_limit = 5,
  advertising_discount_bps = 0,
  affiliate_enabled = false,
  analytics_level = 'basic',
  demand_insights_enabled = false,
  listing_assistant_enabled = false,
  analytics_assistant_enabled = false,
  advanced_tools_enabled = false,
  support_level = 'standard',
  business_name_enabled = false,
  elite_badge_enabled = false
where id = 'starter';

update public.merchant_subscription_plans set
  active_publication_limit = 20,
  advertising_discount_bps = 500,
  affiliate_enabled = true,
  analytics_level = 'full',
  demand_insights_enabled = true,
  listing_assistant_enabled = true,
  analytics_assistant_enabled = false,
  advanced_tools_enabled = true,
  support_level = 'priority',
  business_name_enabled = false,
  elite_badge_enabled = false
where id = 'pro';

update public.merchant_subscription_plans set
  active_publication_limit = null,
  advertising_discount_bps = 1000,
  affiliate_enabled = true,
  analytics_level = 'full',
  demand_insights_enabled = true,
  listing_assistant_enabled = true,
  analytics_assistant_enabled = true,
  advanced_tools_enabled = true,
  support_level = 'highest',
  business_name_enabled = true,
  elite_badge_enabled = true
where id = 'elite';

-- ============================================================
-- GLOBAL CAP -- widen the existing combined-supply counter (previously
-- listings + Available-direction Skill/Task posts only) to also count
-- marketplace_requests (Looking For) and Looking-For-direction Skill/
-- Task posts while they are publicly open (active/offers_received) --
-- superseding the prior "Looking-For never counts" decision. One
-- canonical function, called from every publish/reactivate path below,
-- still takes the same profiles-row lock (held for the rest of the
-- caller's own transaction) to serialize concurrent activations across
-- all three tables against one key.
-- ============================================================
-- ============================================================
-- PUBLICATION FREEZE -- set when a scheduled downgrade takes effect but
-- the merchant never confirmed (or their confirmed selection has since
-- become invalid) a keep-set that fits the new plan's cap. While true,
-- EVERY publish/reactivate RPC refuses outright
-- (_assert_not_publication_frozen) -- nothing is ever auto-deactivated
-- on the merchant's behalf. Defined here (not in the downgrade-workflow
-- migration) because 3 of the RPCs that must call the guard
-- (activate_listing, publish_barter_skill_task_post,
-- publish_marketplace_request) are widened in THIS migration, which
-- runs before the downgrade-workflow migration that actually sets this
-- flag (supabase/migrations/20260819072454_subscription_v2_downgrade_workflow.sql).
-- ============================================================
alter table public.merchant_subscriptions add column if not exists publication_frozen boolean not null default false;

create or replace function public._assert_not_publication_frozen(p_user_id uuid)
returns void
language plpgsql
as $$
declare
  v_frozen boolean;
begin
  select publication_frozen into v_frozen from public.merchant_subscriptions where merchant_id = p_user_id;
  if coalesce(v_frozen, false) then
    raise exception 'publication_frozen_pending_keep_set: resolve your downgrade keep-set selection before publishing or reactivating anything';
  end if;
end;
$$;

create or replace function public._lock_and_count_active_supply(p_user_id uuid)
returns int
language plpgsql
as $$
declare
  v_count int;
begin
  perform 1 from public.profiles where id = p_user_id for update;

  select
    (select count(*) from public.listings where merchant_id = p_user_id and status = 'active' and is_test = false)
    +
    (select count(*) from public.barter_skill_task_posts where owner_id = p_user_id and status in ('active', 'offers_received') and is_test = false)
    +
    (select count(*) from public.marketplace_requests where requester_id = p_user_id and status in ('active', 'offers_received') and is_test = false)
  into v_count;

  return v_count;
end;
$$;

-- ── activate_listing -- use the combined counter + renamed column ──
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
  v_request_hash text;
  v_idem record;
  v_listing_status listing_status;
  v_moderation_status moderation_status;
  v_merchant_id uuid;
  v_is_test boolean;
  v_plan_id text;
  v_publication_limit integer;
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

  perform public._assert_not_publication_frozen(v_merchant_id);

  -- Global publication cap -- real content only, never test fixtures.
  if not v_is_test then
    v_active_count := public._lock_and_count_active_supply(v_merchant_id);
    v_plan_id := public._get_effective_merchant_plan_id(v_merchant_id);
    select active_publication_limit into v_publication_limit from public.merchant_subscription_plans where id = v_plan_id;

    if v_publication_limit is not null and v_active_count >= v_publication_limit then
      raise exception 'active_publication_limit_reached: the % plan allows up to % active published entities', v_plan_id, v_publication_limit;
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

-- ── publish_barter_skill_task_post -- cap check now applies to BOTH
-- directions (previously Available-only); renamed column reference ──
create or replace function public.publish_barter_skill_task_post(
  p_owner_id uuid,
  p_post_id uuid,
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
  v_post public.barter_skill_task_posts;
  v_active_count int;
  v_plan_id text;
  v_publication_limit int;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_owner_id is null then
    raise exception 'not authenticated';
  end if;

  v_request_hash := md5(coalesce(p_post_id::text, ''));
  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_owner_id and operation = 'publish_barter_skill_task_post' and idempotency_key = p_idempotency_key;
    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  perform public._assert_kyc_approved(p_owner_id, 'self');

  select * into v_post from public.barter_skill_task_posts where id = p_post_id for update;
  if v_post is null or v_post.owner_id <> p_owner_id then
    raise exception 'post not found or not owned by caller';
  end if;
  if v_post.title is null or v_post.description is null or v_post.delivery_mode is null then
    raise exception 'title, description, and delivery mode are required before publishing';
  end if;

  perform public._validate_skill_task_content(array[
    v_post.title, v_post.description, v_post.exclusions, v_post.materials_arrangement,
    v_post.evidence_expectations, v_post.desired_exchange_notes, v_post.availability_notes
  ]);

  perform public._validate_skill_task_post_transition(v_post.status, 'active', v_post.direction);
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
  set status = 'active', first_published_at = coalesce(first_published_at, now())
  where id = p_post_id;

  insert into public.barter_skill_task_post_history (post_id, actor_user_id, actor_role, event_type, previous_status, new_status)
  values (p_post_id, p_owner_id, 'owner', 'post_published', v_post.status, 'active');

  v_result := jsonb_build_object('post_id', p_post_id, 'status', 'active');
  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_owner_id, 'publish_barter_skill_task_post', p_idempotency_key, v_request_hash, v_result);
  end if;
  return v_result;
end;
$$;

-- ── resume_barter_skill_task_post -- renamed column reference only,
-- logic unchanged (Available-only transition, per its own status model) ──
create or replace function public.resume_barter_skill_task_post(
  p_owner_id uuid, p_post_id uuid, p_idempotency_key text default null
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
  v_active_count int;
  v_plan_id text;
  v_publication_limit int;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_owner_id is null then
    raise exception 'not authenticated';
  end if;

  v_request_hash := md5(coalesce(p_post_id::text, ''));
  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_owner_id and operation = 'resume_barter_skill_task_post' and idempotency_key = p_idempotency_key;
    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select * into v_post from public.barter_skill_task_posts where id = p_post_id for update;
  if v_post is null or v_post.owner_id <> p_owner_id then
    raise exception 'post not found or not owned by caller';
  end if;

  perform public._validate_skill_task_post_transition(v_post.status, 'active', v_post.direction);
  perform public._assert_not_publication_frozen(p_owner_id);

  if not v_post.is_test then
    v_active_count := public._lock_and_count_active_supply(p_owner_id);
    v_plan_id := public._get_effective_merchant_plan_id(p_owner_id);
    select active_publication_limit into v_publication_limit from public.merchant_subscription_plans where id = v_plan_id;
    if v_publication_limit is not null and v_active_count >= v_publication_limit then
      raise exception 'active_publication_limit_reached: the % plan allows up to % active published entities', v_plan_id, v_publication_limit;
    end if;
  end if;

  update public.barter_skill_task_posts set status = 'active' where id = p_post_id;

  insert into public.barter_skill_task_post_history (post_id, actor_user_id, actor_role, event_type, previous_status, new_status)
  values (p_post_id, p_owner_id, 'owner', 'post_resumed', v_post.status, 'active');

  v_result := jsonb_build_object('post_id', p_post_id, 'status', 'active');
  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_owner_id, 'resume_barter_skill_task_post', p_idempotency_key, v_request_hash, v_result);
  end if;
  return v_result;
end;
$$;

-- ── admin_restore_barter_skill_task_post -- renamed column reference only ──
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
  values (p_post_id, p_admin_id, 'admin', 'post_restored', 'suspended', v_restore_status::text, p_reason);

  v_result := jsonb_build_object('post_id', p_post_id, 'status', v_restore_status);
  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_admin_id, 'admin_restore_barter_skill_task_post', p_idempotency_key, v_request_hash, v_result);
  end if;
  return v_result;
end;
$$;

-- ── publish_marketplace_request -- NEW cap check (none existed before) ──
create or replace function public.publish_marketplace_request(
  p_actor_user_id uuid, p_request_id uuid, p_idempotency_key text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_request record;
  v_kyc text;
  v_active_count int;
  v_plan_id text;
  v_publication_limit int;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  if p_actor_user_id is null then raise exception 'not authenticated'; end if;

  select * into v_request from public.marketplace_requests where id = p_request_id for update;
  if v_request.id is null then raise exception 'request not found'; end if;
  if v_request.requester_id <> p_actor_user_id then raise exception 'not the owner of this request'; end if;
  if v_request.status <> 'draft' then raise exception 'request is in status % and cannot be published from here', v_request.status; end if;

  select kyc_status::text into v_kyc from public.profiles where id = p_actor_user_id;
  if v_kyc is distinct from 'approved' then
    raise exception 'verification_required: KYC approval is required to publish a request';
  end if;

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
  perform public._marketplace_request_history(p_request_id, null, 'requester', p_actor_user_id, 'published', 'draft', 'active');

  v_result := jsonb_build_object('request_id', p_request_id, 'status', 'active');
  return v_result;
end;
$$;

-- ============================================================
-- AFFILIATE -- new merchant participation requires Pro/Elite (Starter
-- keeps ALL its existing enabled listings' historical attribution --
-- this only blocks NEWLY enabling affiliates on a listing).
-- ============================================================
create or replace function public.enable_listing_affiliate(
  p_actor_type text,
  p_actor_id uuid,
  p_listing_id uuid,
  p_reason text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_listing record;
  v_plan_id text;
  v_affiliate_enabled boolean;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_actor_type not in ('merchant', 'admin') then
    raise exception 'invalid actor type';
  end if;
  if p_actor_type = 'admin' and (p_reason is null or length(trim(p_reason)) = 0) then
    raise exception 'a reason is required for an admin override';
  end if;

  select id, merchant_id into v_listing from public.listings where id = p_listing_id;
  if v_listing.id is null then
    raise exception 'listing not found';
  end if;
  if p_actor_type = 'merchant' and v_listing.merchant_id <> p_actor_id then
    raise exception 'you do not own this listing';
  end if;

  if p_actor_type = 'merchant' then
    v_plan_id := public._get_effective_merchant_plan_id(v_listing.merchant_id);
    select affiliate_enabled into v_affiliate_enabled from public.merchant_subscription_plans where id = v_plan_id;
    if not coalesce(v_affiliate_enabled, false) then
      raise exception 'affiliate_requires_pro_or_elite: enabling affiliates requires an active Pro or Elite subscription';
    end if;
  end if;

  update public.listings
  set accepts_affiliates = true, affiliate_enabled_at = now(), affiliate_enabled_by = p_actor_id, affiliate_disabled_at = null
  where id = p_listing_id;

  return jsonb_build_object('listing_id', p_listing_id, 'accepts_affiliates', true);
end;
$$;

-- ============================================================
-- ADVERTISING DISCOUNT -- resolved from the actor's effective plan at
-- draft-creation time (the genuine commercial-terms snapshot point --
-- fund_ad_campaign only charges snapshot_price_cents, never
-- recalculates it). A later subscription change never touches an
-- already-created campaign's snapshot. Single discount source, no
-- stacking: this IS "the applicable plan discount," full stop.
-- ============================================================
alter table public.ad_campaigns
  add column if not exists snapshot_base_price_cents integer,
  add column if not exists snapshot_discount_bps integer not null default 0 check (snapshot_discount_bps between 0 and 10000),
  add column if not exists snapshot_discount_cents integer not null default 0 check (snapshot_discount_cents >= 0),
  add column if not exists snapshot_subscription_plan_id text references public.merchant_subscription_plans(id);

update public.ad_campaigns set snapshot_base_price_cents = snapshot_price_cents where snapshot_base_price_cents is null;
alter table public.ad_campaigns alter column snapshot_base_price_cents set not null;

create or replace function public.create_ad_campaign_draft(
  p_actor_profile_id uuid,
  p_advertiser_id uuid,
  p_package_id uuid,
  p_target_type ad_campaign_target_type,
  p_listing_id uuid default null,
  p_marketplace_request_id uuid default null,
  p_barter_skill_task_post_id uuid default null,
  p_end_at timestamptz default null,
  p_is_test boolean default false,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_advertiser public.ad_advertisers;
  v_package public.ad_packages;
  v_campaign public.ad_campaigns;
  v_owns_target boolean;
  v_request_hash text;
  v_idem record;
  v_result jsonb;
  v_plan_id text;
  v_discount_bps int;
  v_discount_cents int;
  v_final_price_cents int;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_actor_profile_id is null then
    raise exception 'actor profile id is required';
  end if;

  select * into v_advertiser from public.ad_advertisers where id = p_advertiser_id;
  if not found then
    raise exception 'advertiser not found';
  end if;
  if v_advertiser.owner_profile_id <> p_actor_profile_id then
    raise exception 'not authorized: caller does not own this advertiser account';
  end if;
  if v_advertiser.status in ('suspended', 'rejected') then
    raise exception 'advertiser account is not eligible to create campaigns (status: %)', v_advertiser.status;
  end if;

  select * into v_package from public.ad_packages where id = p_package_id;
  if not found or not v_package.is_active then
    raise exception 'package is not available';
  end if;
  if v_package.inventory_class = 'unity_marketplace' and (v_advertiser.advertiser_type <> 'unity' or p_target_type = 'external') then
    raise exception 'this package requires a Unity marketplace advertiser and target';
  end if;
  if v_package.inventory_class = 'external' and (v_advertiser.advertiser_type <> 'external' or p_target_type <> 'external') then
    raise exception 'this package requires an external advertiser and target';
  end if;

  if p_target_type = 'listing' then
    select exists (select 1 from public.listings where id = p_listing_id and merchant_id = p_actor_profile_id and (p_is_test or is_test = false)) into v_owns_target;
  elsif p_target_type = 'marketplace_request' then
    select exists (select 1 from public.marketplace_requests where id = p_marketplace_request_id and requester_id = p_actor_profile_id and (p_is_test or is_test = false)) into v_owns_target;
  elsif p_target_type = 'barter_skill_task_post' then
    select exists (select 1 from public.barter_skill_task_posts where id = p_barter_skill_task_post_id and owner_id = p_actor_profile_id and (p_is_test or is_test = false)) into v_owns_target;
  else
    v_owns_target := true;
  end if;

  if not v_owns_target then
    raise exception 'target not found, not owned by caller, or is test content ineligible for a real campaign';
  end if;

  v_request_hash := md5(coalesce(p_advertiser_id::text,'') || '|' || coalesce(p_package_id::text,'') || '|' || coalesce(p_target_type::text,'') ||
    '|' || coalesce(p_listing_id::text,'') || '|' || coalesce(p_marketplace_request_id::text,'') || '|' || coalesce(p_barter_skill_task_post_id::text,'') ||
    '|' || coalesce(p_end_at::text,''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_actor_profile_id and operation = 'create_ad_campaign_draft' and idempotency_key = p_idempotency_key;
    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  -- Subscription ad-discount, resolved once, right here, and snapshotted
  -- (never recalculated at fund time or reinterpreted from a later plan
  -- change). Integer basis-points math throughout -- no floating point.
  v_plan_id := public._get_effective_merchant_plan_id(p_actor_profile_id);
  select advertising_discount_bps into v_discount_bps from public.merchant_subscription_plans where id = v_plan_id;
  v_discount_bps := coalesce(v_discount_bps, 0);
  v_discount_cents := (v_package.price_cents * v_discount_bps) / 10000;
  v_final_price_cents := v_package.price_cents - v_discount_cents;

  insert into public.ad_campaigns (
    advertiser_id, package_id, status, target_type, listing_id, marketplace_request_id, barter_skill_task_post_id,
    snapshot_placement_type, snapshot_placement_tier, snapshot_position_band, snapshot_price_cents, snapshot_currency,
    snapshot_impression_quota, snapshot_commercial_version, funded_amount_cents, end_at, is_test,
    snapshot_base_price_cents, snapshot_discount_bps, snapshot_discount_cents, snapshot_subscription_plan_id
  ) values (
    p_advertiser_id, p_package_id, 'draft', p_target_type, p_listing_id, p_marketplace_request_id, p_barter_skill_task_post_id,
    v_package.placement_type, v_package.placement_tier, v_package.position_band, v_final_price_cents, v_package.currency,
    v_package.impression_quota, v_package.commercial_version, v_final_price_cents, p_end_at, p_is_test,
    v_package.price_cents, v_discount_bps, v_discount_cents, v_plan_id
  ) returning * into v_campaign;

  insert into public.ad_campaign_history (campaign_id, actor_type, actor_id, action_type, previous_status, new_status)
  values (v_campaign.id, 'advertiser', p_actor_profile_id, 'created', null, 'draft');

  insert into public.ad_targeting (campaign_id) values (v_campaign.id);

  if p_target_type = 'external' then
    insert into public.ad_creatives (campaign_id, headline, cta_text, destination_url)
    values (v_campaign.id, 'Draft headline', 'Learn more', 'https://example.invalid/draft');
  end if;

  v_result := to_jsonb(v_campaign);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_actor_profile_id, 'create_ad_campaign_draft', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;
