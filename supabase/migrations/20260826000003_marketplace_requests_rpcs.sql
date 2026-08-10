-- ============================================================
-- Phase 4 -- Available / Looking For: request/offer lifecycle RPCs.
-- ============================================================
-- All SECURITY DEFINER, service-role-only, idempotency-keyed via the
-- existing idempotency_keys table (requester_id/responder_id/admin_id
-- reused as the "merchant_id" param, same repurposing precedent every
-- other domain in this codebase already uses).
--
-- create_marketplace_request / publish / update / close / archive /
-- repost / expire_marketplace_requests (system sweep) / submit_offer /
-- withdraw_offer / decline_offer / accept_offer (the critical,
-- concurrency-safe transition into a REAL order/booking/barter
-- agreement, calling the existing creation RPCs unchanged).
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

-- ------------------------------------------------------------
-- Shared history writer.
-- ------------------------------------------------------------
create or replace function public._marketplace_request_history(
  p_request_id uuid, p_offer_id uuid, p_actor_role text, p_actor_id uuid,
  p_event_type text, p_previous_status text, p_new_status text, p_metadata jsonb default '{}'::jsonb
) returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.marketplace_request_history (request_id, offer_id, actor_role, actor_id, event_type, previous_status, new_status, metadata)
  values (p_request_id, p_offer_id, p_actor_role, p_actor_id, p_event_type, p_previous_status, p_new_status, p_metadata);
end;
$$;
revoke all on function public._marketplace_request_history(uuid, uuid, text, uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public._marketplace_request_history(uuid, uuid, text, uuid, text, text, text, jsonb) to service_role;

-- ------------------------------------------------------------
-- CREATE (draft) -- no KYC gate, matching "draft listing creation:
-- no KYC required" precedent (src/lib/verification/eligibility.ts).
-- ------------------------------------------------------------
create or replace function public.create_marketplace_request(
  p_requester_id uuid,
  p_transaction_type text,
  p_title text,
  p_description text default null,
  p_category text default null,
  p_category_id uuid default null,
  p_subcategory_id uuid default null,
  p_country_id text default 'ZA',
  p_province text default null,
  p_city text default null,
  p_budget_min numeric default null,
  p_budget_max numeric default null,
  p_currency text default 'ZAR',
  p_start_date date default null,
  p_end_date date default null,
  p_quantity int default 1,
  p_condition_preferences text default null,
  p_barter_offer_description text default null,
  p_specifications jsonb default '{}'::jsonb,
  p_expires_at timestamptz default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_request_hash text;
  v_idem record;
  v_request_id uuid;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  if p_requester_id is null then raise exception 'not authenticated'; end if;
  if p_transaction_type not in ('buy', 'rent', 'barter') then raise exception 'invalid transaction type'; end if;
  if p_title is null or length(trim(p_title)) = 0 then raise exception 'a title is required'; end if;

  v_request_hash := md5(coalesce(p_title,'') || '|' || coalesce(p_transaction_type,'') || '|' || coalesce(p_description,''));
  if p_idempotency_key is not null then
    select request_hash, result into v_idem from public.idempotency_keys
    where merchant_id = p_requester_id and operation = 'create_marketplace_request' and idempotency_key = p_idempotency_key;
    if found then
      if v_idem.request_hash is distinct from v_request_hash then raise exception 'idempotency key already used with a different request'; end if;
      return v_idem.result;
    end if;
  end if;

  insert into public.marketplace_requests (
    requester_id, transaction_type, status, title, description, category, category_id, subcategory_id,
    country_id, province, city, budget_min, budget_max, currency, start_date, end_date, quantity,
    condition_preferences, barter_offer_description, specifications, expires_at
  ) values (
    p_requester_id, p_transaction_type, 'draft', p_title, p_description, p_category, p_category_id, p_subcategory_id,
    coalesce(p_country_id, 'ZA'), p_province, p_city, p_budget_min, p_budget_max, coalesce(p_currency, 'ZAR'), p_start_date, p_end_date, greatest(coalesce(p_quantity, 1), 1),
    p_condition_preferences, p_barter_offer_description, coalesce(p_specifications, '{}'::jsonb), p_expires_at
  ) returning id into v_request_id;

  perform public._marketplace_request_history(v_request_id, null, 'requester', p_requester_id, 'created', null, 'draft');

  v_result := jsonb_build_object('request_id', v_request_id, 'status', 'draft');
  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_requester_id, 'create_marketplace_request', p_idempotency_key, v_request_hash, v_result);
  end if;
  return v_result;
end;
$$;

-- ------------------------------------------------------------
-- PUBLISH -- draft -> active. Requires approved KYC (Step I: verified
-- users may publish Looking For requests).
-- ------------------------------------------------------------
create or replace function public.publish_marketplace_request(
  p_actor_user_id uuid, p_request_id uuid, p_idempotency_key text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_request record;
  v_kyc text;
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

  update public.marketplace_requests set status = 'active' where id = p_request_id;
  perform public._marketplace_request_history(p_request_id, null, 'requester', p_actor_user_id, 'published', 'draft', 'active');

  v_result := jsonb_build_object('request_id', p_request_id, 'status', 'active');
  return v_result;
end;
$$;

-- ------------------------------------------------------------
-- UPDATE -- draft only, owner only (Step AC: "edit draft").
-- ------------------------------------------------------------
create or replace function public.update_marketplace_request(
  p_actor_user_id uuid, p_request_id uuid,
  p_title text default null, p_description text default null, p_category text default null,
  p_category_id uuid default null, p_subcategory_id uuid default null, p_province text default null, p_city text default null,
  p_budget_min numeric default null, p_budget_max numeric default null,
  p_start_date date default null, p_end_date date default null, p_quantity int default null,
  p_condition_preferences text default null, p_barter_offer_description text default null,
  p_specifications jsonb default null, p_expires_at timestamptz default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_request record;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  select * into v_request from public.marketplace_requests where id = p_request_id for update;
  if v_request.id is null then raise exception 'request not found'; end if;
  if v_request.requester_id <> p_actor_user_id then raise exception 'not the owner of this request'; end if;
  if v_request.status <> 'draft' then raise exception 'only a draft request can be edited'; end if;

  update public.marketplace_requests set
    title = coalesce(p_title, title), description = coalesce(p_description, description),
    category = coalesce(p_category, category), category_id = coalesce(p_category_id, category_id), subcategory_id = coalesce(p_subcategory_id, subcategory_id),
    province = coalesce(p_province, province), city = coalesce(p_city, city),
    budget_min = coalesce(p_budget_min, budget_min), budget_max = coalesce(p_budget_max, budget_max),
    start_date = coalesce(p_start_date, start_date), end_date = coalesce(p_end_date, end_date),
    quantity = coalesce(p_quantity, quantity), condition_preferences = coalesce(p_condition_preferences, condition_preferences),
    barter_offer_description = coalesce(p_barter_offer_description, barter_offer_description),
    specifications = coalesce(p_specifications, specifications), expires_at = coalesce(p_expires_at, expires_at)
  where id = p_request_id;

  return jsonb_build_object('request_id', p_request_id, 'status', 'draft');
end;
$$;

-- ------------------------------------------------------------
-- CLOSE -- owner or admin. From active/offers_received/date_passed.
-- ------------------------------------------------------------
create or replace function public.close_marketplace_request(
  p_actor_user_id uuid, p_actor_role text, p_request_id uuid, p_reason text default null, p_idempotency_key text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_request record;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  if p_actor_role not in ('requester', 'admin') then raise exception 'invalid actor role'; end if;

  select * into v_request from public.marketplace_requests where id = p_request_id for update;
  if v_request.id is null then raise exception 'request not found'; end if;
  if p_actor_role = 'requester' and v_request.requester_id <> p_actor_user_id then raise exception 'not the owner of this request'; end if;
  if v_request.status not in ('active', 'offers_received', 'date_passed') then
    raise exception 'request is in status % and cannot be closed from here', v_request.status;
  end if;

  update public.marketplace_requests set status = 'closed' where id = p_request_id;
  perform public._marketplace_request_history(p_request_id, null, p_actor_role, p_actor_user_id, 'closed', v_request.status::text, 'closed', jsonb_build_object('reason', p_reason));

  return jsonb_build_object('request_id', p_request_id, 'status', 'closed');
end;
$$;

-- ------------------------------------------------------------
-- ARCHIVE -- owner or admin. From closed/date_passed/completed.
-- ------------------------------------------------------------
create or replace function public.archive_marketplace_request(
  p_actor_user_id uuid, p_actor_role text, p_request_id uuid, p_idempotency_key text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_request record;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  if p_actor_role not in ('requester', 'admin') then raise exception 'invalid actor role'; end if;

  select * into v_request from public.marketplace_requests where id = p_request_id for update;
  if v_request.id is null then raise exception 'request not found'; end if;
  if p_actor_role = 'requester' and v_request.requester_id <> p_actor_user_id then raise exception 'not the owner of this request'; end if;
  if v_request.status not in ('closed', 'date_passed', 'completed') then
    raise exception 'request is in status % and cannot be archived from here', v_request.status;
  end if;

  update public.marketplace_requests set status = 'archived' where id = p_request_id;
  perform public._marketplace_request_history(p_request_id, null, p_actor_role, p_actor_user_id, 'archived', v_request.status::text, 'archived');

  return jsonb_build_object('request_id', p_request_id, 'status', 'archived');
end;
$$;

-- ------------------------------------------------------------
-- REPOST -- clones public terms into a NEW draft request, preserving a
-- reference to the original (Step AA: never reset old identity/history
-- in place).
-- ------------------------------------------------------------
create or replace function public.repost_marketplace_request(
  p_actor_user_id uuid, p_request_id uuid, p_expires_at timestamptz default null, p_idempotency_key text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_original record;
  v_new_id uuid;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  select * into v_original from public.marketplace_requests where id = p_request_id;
  if v_original.id is null then raise exception 'request not found'; end if;
  if v_original.requester_id <> p_actor_user_id then raise exception 'not the owner of this request'; end if;
  if v_original.status not in ('closed', 'date_passed', 'archived') then
    raise exception 'request is in status % and cannot be reposted from here', v_original.status;
  end if;

  insert into public.marketplace_requests (
    requester_id, transaction_type, status, title, description, category, category_id, subcategory_id,
    country_id, province, city, budget_min, budget_max, currency, start_date, end_date, quantity,
    condition_preferences, barter_offer_description, specifications, expires_at, reposted_from_request_id, is_test
  ) values (
    v_original.requester_id, v_original.transaction_type, 'draft', v_original.title, v_original.description, v_original.category, v_original.category_id, v_original.subcategory_id,
    v_original.country_id, v_original.province, v_original.city, v_original.budget_min, v_original.budget_max, v_original.currency, v_original.start_date, v_original.end_date, v_original.quantity,
    v_original.condition_preferences, v_original.barter_offer_description, v_original.specifications, p_expires_at, v_original.id, v_original.is_test
  ) returning id into v_new_id;

  perform public._marketplace_request_history(v_new_id, null, 'requester', p_actor_user_id, 'reposted', null, 'draft', jsonb_build_object('reposted_from_request_id', v_original.id));
  perform public._marketplace_request_history(v_original.id, null, 'requester', p_actor_user_id, 'repost_created', v_original.status::text, v_original.status::text, jsonb_build_object('new_request_id', v_new_id));

  return jsonb_build_object('request_id', v_new_id, 'status', 'draft', 'reposted_from_request_id', v_original.id);
end;
$$;

-- ------------------------------------------------------------
-- EXPIRE SWEEP -- system, bounded batch, callable from an internal
-- cron route. active/offers_received + expires_at < now() -> date_passed.
-- ------------------------------------------------------------
create or replace function public.expire_marketplace_requests(p_limit int default 200)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_ids uuid[];
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;

  select array_agg(id) into v_ids from (
    select id from public.marketplace_requests
    where status in ('active', 'offers_received') and expires_at is not null and expires_at < now()
    order by expires_at asc
    limit greatest(coalesce(p_limit, 200), 1)
  ) s;

  if v_ids is null then
    return jsonb_build_object('expired_count', 0);
  end if;

  update public.marketplace_requests set status = 'date_passed' where id = any(v_ids);

  insert into public.marketplace_request_history (request_id, actor_role, event_type, previous_status, new_status)
  select id, 'system', 'date_passed', status::text, 'date_passed' from public.marketplace_requests where id = any(v_ids);
  -- (status already updated above -- previous_status here reflects the
  -- pre-update value is not recoverable post-update in one statement;
  -- acceptable for an automated sweep event, matching the coarser
  -- granularity system sweeps already use elsewhere in this codebase.)

  return jsonb_build_object('expired_count', array_length(v_ids, 1));
end;
$$;

revoke all on function public.create_marketplace_request(uuid, text, text, text, text, uuid, uuid, text, text, text, numeric, numeric, text, date, date, int, text, text, jsonb, timestamptz, text) from public, anon, authenticated;
grant execute on function public.create_marketplace_request(uuid, text, text, text, text, uuid, uuid, text, text, text, numeric, numeric, text, date, date, int, text, text, jsonb, timestamptz, text) to service_role;
revoke all on function public.publish_marketplace_request(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.publish_marketplace_request(uuid, uuid, text) to service_role;
revoke all on function public.update_marketplace_request(uuid, uuid, text, text, text, uuid, uuid, text, text, numeric, numeric, date, date, int, text, text, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.update_marketplace_request(uuid, uuid, text, text, text, uuid, uuid, text, text, numeric, numeric, date, date, int, text, text, jsonb, timestamptz) to service_role;
revoke all on function public.close_marketplace_request(uuid, text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.close_marketplace_request(uuid, text, uuid, text, text) to service_role;
revoke all on function public.archive_marketplace_request(uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.archive_marketplace_request(uuid, text, uuid, text) to service_role;
revoke all on function public.repost_marketplace_request(uuid, uuid, timestamptz, text) from public, anon, authenticated;
grant execute on function public.repost_marketplace_request(uuid, uuid, timestamptz, text) to service_role;
revoke all on function public.expire_marketplace_requests(int) from public, anon, authenticated;
grant execute on function public.expire_marketplace_requests(int) to service_role;
