-- ============================================================
-- Fix-forward: two functions were silently clobbered by applying the
-- Subscription V2 migrations out of timestamp order (they are dated
-- 2026-08-19, but were only actually applied to DEVELOPMENT on
-- 2026-08-19 via `supabase db push --linked --include-all`, well after
-- several later-dated migrations -- 2026-08-22 through 2026-09-04 --
-- had already redefined the same function names in the meantime).
-- `CREATE OR REPLACE FUNCTION` always takes whichever definition ran
-- last in real execution time, regardless of the migration's filename
-- timestamp, so applying the V2 files re-ran their (older-authored)
-- bodies over two functions that had since gained real logic. Audited
-- every function name the 5 V2 migrations share with any migration
-- timestamped after them; these two are the only ones where the V2
-- version was not already a strict superset of what it overwrote.
--
-- 1. create_ad_campaign_draft: 20260903000010 added an `end_at` must-
--    be-in-the-future validation that 20260819072044's version never
--    had (it predates that validation being added). Restored.
-- 2. resume_barter_skill_task_post: 20260901000009's version required
--    KYC approval (_assert_kyc_approved) before resuming a post;
--    20260819072044's version dropped that call. Restored.
--
-- Both fixes below are the V2 version's body with the missing check
-- reinserted at its original position -- no other behavior change.
-- ============================================================

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
  if p_end_at is null or p_end_at <= now() then
    raise exception 'end_at is required and must be in the future';
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

  perform public._assert_kyc_approved(p_owner_id, 'self');

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
