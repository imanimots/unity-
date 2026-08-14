-- ============================================================
-- Skills + Tasks under Barter -- posts lifecycle RPCs.
-- ============================================================
-- Self-serve publish (KYC + content-validated + cap-checked), no
-- admin pre-approval -- proportional to the risk (mirrors
-- publish_marketplace_request's own self-serve, KYC-gated shape),
-- with reactive controls (post-level reports, admin suspend) instead
-- of a moderation queue.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- Shared content validator. Defense-in-depth layer, not a claimed
-- guarantee -- a chat-filter.ts-shaped keyword rule list, called
-- against every user-authored text field at every write surface that
-- can introduce or change Skill/Task content. Medical/medicinal
-- keywords are checked separately from, and never include, lawful
-- non-medical wellness terms.
-- ────────────────────────────────────────────────────────────
create or replace function public._validate_skill_task_content(p_texts text[])
returns void
language plpgsql
as $$
declare
  v_text text;
  v_lower text;
  v_illegal_patterns text[] := array[
    'stolen', 'counterfeit', 'fake id', 'forged document', 'drug dealing', 'sell drugs',
    'illegal firearm', 'unlicensed firearm', 'human trafficking', 'money laundering'
  ];
  v_medical_patterns text[] := array[
    'diagnos', 'prescri', 'medical treatment', 'medicinal treatment', 'administer medication',
    'give injections', 'perform surgery', 'clinical advice', 'medical procedure', 'medical care'
  ];
  v_pattern text;
begin
  foreach v_text in array p_texts loop
    if v_text is null then continue; end if;
    v_lower := lower(v_text);

    foreach v_pattern in array v_illegal_patterns loop
      if v_lower like '%' || v_pattern || '%' then
        raise exception 'prohibited_content: this text appears to describe illegal work and cannot be published';
      end if;
    end loop;

    foreach v_pattern in array v_medical_patterns loop
      if v_lower like '%' || v_pattern || '%' then
        raise exception 'prohibited_content: this text appears to describe medical/medicinal work, which is not permitted -- lawful non-medical wellness activity (e.g. fitness coaching, exercise instruction) remains allowed';
      end if;
    end loop;
  end loop;
end;
$$;

-- ────────────────────────────────────────────────────────────
-- Direction-aware post status transition validation.
-- ────────────────────────────────────────────────────────────
create or replace function public._validate_skill_task_post_transition(
  p_current barter_skill_task_post_status,
  p_new barter_skill_task_post_status,
  p_direction text
)
returns void
language plpgsql
as $$
begin
  if p_direction = 'available' then
    if not (
      (p_current = 'draft' and p_new = 'active')
      or (p_current = 'active' and p_new in ('paused', 'archived', 'suspended'))
      or (p_current = 'paused' and p_new in ('active', 'archived', 'suspended'))
      or (p_current = 'suspended' and p_new in ('active', 'paused'))
    ) then
      raise exception 'invalid_transition: % -> % is not a legal transition for an Available post', p_current, p_new;
    end if;
  else
    if not (
      (p_current = 'draft' and p_new = 'active')
      or (p_current = 'active' and p_new in ('offers_received', 'closed', 'suspended'))
      or (p_current = 'offers_received' and p_new in ('matched', 'closed', 'suspended'))
      or (p_current = 'suspended' and p_new in ('active', 'offers_received'))
      or (p_current in ('closed', 'matched') and p_new = 'archived')
    ) then
      raise exception 'invalid_transition: % -> % is not a legal transition for a Looking-For post', p_current, p_new;
    end if;
  end if;
end;
$$;

-- ────────────────────────────────────────────────────────────
-- Combined active-supply count, WITH the shared concurrency lock.
-- Locking the caller's own profiles row here (held for the rest of
-- the enclosing transaction, since this executes within the calling
-- RPC's own transaction) is what serializes two concurrent
-- activation attempts by the same user -- one a physical listing,
-- one a Skill/Task -- against the same key, regardless of which
-- table each targets.
-- ────────────────────────────────────────────────────────────
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
    (select count(*) from public.barter_skill_task_posts where owner_id = p_user_id and direction = 'available' and status = 'active' and is_test = false)
  into v_count;

  return v_count;
end;
$$;

-- ────────────────────────────────────────────────────────────
-- Draft create/update -- mirrors save_listing_draft's own shape.
-- KYC not required at draft stage (matches create_marketplace_request's
-- "draft creation: no KYC required" precedent). kind/direction are
-- only ever set here, at draft/create time -- update_barter_skill_task_post
-- (below) never accepts them.
-- ────────────────────────────────────────────────────────────
create or replace function public.save_barter_skill_task_post_draft(
  p_owner_id uuid,
  p_post_id uuid default null,
  p_kind text default null,
  p_direction text default null,
  p_title text default null,
  p_description text default null,
  p_category_slug text default null,
  p_delivery_mode text default null,
  p_province text default null,
  p_city text default null,
  p_exclusions text default null,
  p_materials_arrangement text default null,
  p_evidence_expectations text default null,
  p_desired_exchange_notes text default null,
  p_wants_item boolean default false,
  p_wants_skill boolean default false,
  p_wants_task boolean default false,
  p_wants_cash_adjustment boolean default false,
  p_availability_notes text default null,
  p_preferred_start_date date default null,
  p_preferred_start_time time default null,
  p_deadline date default null,
  p_expected_duration_notes text default null,
  p_milestone_templates jsonb default '[]'::jsonb,
  p_idempotency_key text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request_hash text;
  v_idem record;
  v_post_id uuid;
  v_category_id uuid;
  v_item jsonb;
  v_weight_sum numeric;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_owner_id is null then
    raise exception 'not authenticated';
  end if;

  v_request_hash := md5(coalesce(p_post_id::text, '') || '|' || coalesce(p_title, '') || '|' || coalesce(p_description, '') || '|' || coalesce(p_milestone_templates::text, '[]'));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_owner_id and operation = 'save_barter_skill_task_post_draft' and idempotency_key = p_idempotency_key;
    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return (v_idem.result->>'post_id')::uuid;
    end if;
  end if;

  perform public._validate_skill_task_content(array[
    p_title, p_description, p_exclusions, p_materials_arrangement, p_evidence_expectations, p_desired_exchange_notes, p_availability_notes
  ]);

  if p_category_slug is not null then
    select id into v_category_id from public.categories where slug = p_category_slug and is_active = true;
    if v_category_id is null then
      raise exception 'invalid or inactive category: %', p_category_slug;
    end if;
  end if;

  if p_post_id is null then
    if p_kind not in ('skill', 'task') then
      raise exception 'kind must be skill or task';
    end if;
    if p_direction not in ('available', 'looking_for') then
      raise exception 'direction must be available or looking_for';
    end if;

    insert into public.barter_skill_task_posts (
      owner_id, kind, direction, title, description, category_id, delivery_mode, province, city,
      exclusions, materials_arrangement, evidence_expectations, desired_exchange_notes,
      wants_item, wants_skill, wants_task, wants_cash_adjustment,
      availability_notes, preferred_start_date, preferred_start_time, deadline, expected_duration_notes,
      status
    ) values (
      p_owner_id, p_kind, p_direction, p_title, p_description, v_category_id, p_delivery_mode, p_province, p_city,
      p_exclusions, p_materials_arrangement, p_evidence_expectations, p_desired_exchange_notes,
      p_wants_item, p_wants_skill, p_wants_task, p_wants_cash_adjustment,
      p_availability_notes, p_preferred_start_date, p_preferred_start_time, p_deadline, p_expected_duration_notes,
      'draft'
    )
    returning id into v_post_id;

    insert into public.barter_skill_task_post_history (post_id, actor_user_id, actor_role, event_type, new_status)
    values (v_post_id, p_owner_id, 'owner', 'post_created_as_draft', 'draft');
  else
    if not exists (
      select 1 from public.barter_skill_task_posts where id = p_post_id and owner_id = p_owner_id and status = 'draft'
    ) then
      raise exception 'post not found, not owned by caller, or no longer a draft';
    end if;

    v_post_id := p_post_id;

    update public.barter_skill_task_posts set
      title = coalesce(p_title, title),
      description = coalesce(p_description, description),
      category_id = coalesce(v_category_id, category_id),
      delivery_mode = coalesce(p_delivery_mode, delivery_mode),
      province = coalesce(p_province, province),
      city = coalesce(p_city, city),
      exclusions = p_exclusions,
      materials_arrangement = p_materials_arrangement,
      evidence_expectations = p_evidence_expectations,
      desired_exchange_notes = p_desired_exchange_notes,
      wants_item = p_wants_item,
      wants_skill = p_wants_skill,
      wants_task = p_wants_task,
      wants_cash_adjustment = p_wants_cash_adjustment,
      availability_notes = p_availability_notes,
      preferred_start_date = p_preferred_start_date,
      preferred_start_time = p_preferred_start_time,
      deadline = p_deadline,
      expected_duration_notes = p_expected_duration_notes
    where id = v_post_id;
  end if;

  delete from public.barter_skill_task_post_milestone_templates where post_id = v_post_id;
  if jsonb_array_length(p_milestone_templates) > 0 then
    select sum((v_item->>'weight_percent')::numeric) into v_weight_sum
    from jsonb_array_elements(p_milestone_templates) as v_item;
    if v_weight_sum is distinct from 100 then
      raise exception 'milestone template weights must sum to exactly 100, got %', v_weight_sum;
    end if;

    for v_item in select * from jsonb_array_elements(p_milestone_templates) loop
      insert into public.barter_skill_task_post_milestone_templates (post_id, title, description, sequence, weight_percent)
      values (v_post_id, v_item->>'title', v_item->>'description', (v_item->>'sequence')::int, (v_item->>'weight_percent')::numeric);
    end loop;
  end if;

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_owner_id, 'save_barter_skill_task_post_draft', p_idempotency_key, v_request_hash, jsonb_build_object('post_id', v_post_id));
  end if;

  return v_post_id;
end;
$$;

-- ────────────────────────────────────────────────────────────
-- Post-publish edit -- deliberately has NO kind/direction parameter
-- at all, making their immutability structural rather than a runtime
-- check. Usable while active/paused/offers_received (not while
-- suspended/matched/closed/archived).
-- ────────────────────────────────────────────────────────────
create or replace function public.update_barter_skill_task_post(
  p_owner_id uuid,
  p_post_id uuid,
  p_title text default null,
  p_description text default null,
  p_delivery_mode text default null,
  p_province text default null,
  p_city text default null,
  p_exclusions text default null,
  p_materials_arrangement text default null,
  p_evidence_expectations text default null,
  p_desired_exchange_notes text default null,
  p_availability_notes text default null,
  p_preferred_start_date date default null,
  p_preferred_start_time time default null,
  p_deadline date default null,
  p_expected_duration_notes text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_post public.barter_skill_task_posts;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;

  select * into v_post from public.barter_skill_task_posts where id = p_post_id for update;
  if v_post is null or v_post.owner_id <> p_owner_id then
    raise exception 'post not found or not owned by caller';
  end if;
  if v_post.status not in ('active', 'paused', 'offers_received') then
    raise exception 'post cannot be edited in its current status';
  end if;

  perform public._validate_skill_task_content(array[
    p_title, p_description, p_exclusions, p_materials_arrangement, p_evidence_expectations, p_desired_exchange_notes, p_availability_notes
  ]);

  update public.barter_skill_task_posts set
    title = coalesce(p_title, title),
    description = coalesce(p_description, description),
    delivery_mode = coalesce(p_delivery_mode, delivery_mode),
    province = coalesce(p_province, province),
    city = coalesce(p_city, city),
    exclusions = coalesce(p_exclusions, exclusions),
    materials_arrangement = coalesce(p_materials_arrangement, materials_arrangement),
    evidence_expectations = coalesce(p_evidence_expectations, evidence_expectations),
    desired_exchange_notes = coalesce(p_desired_exchange_notes, desired_exchange_notes),
    availability_notes = coalesce(p_availability_notes, availability_notes),
    preferred_start_date = coalesce(p_preferred_start_date, preferred_start_date),
    preferred_start_time = coalesce(p_preferred_start_time, preferred_start_time),
    deadline = coalesce(p_deadline, deadline),
    expected_duration_notes = coalesce(p_expected_duration_notes, expected_duration_notes)
  where id = p_post_id;

  return jsonb_build_object('post_id', p_post_id);
end;
$$;

-- ────────────────────────────────────────────────────────────
-- Publish: draft -> active. KYC-approved, content-validated,
-- cap-checked (Available only). Sets first_published_at once, never
-- cleared -- this is what makes kind/direction immutable forever
-- after the first publish, even across later pause/archive/reuse.
-- ────────────────────────────────────────────────────────────
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
  v_listing_limit int;
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

  if v_post.direction = 'available' and not v_post.is_test then
    v_active_count := public._lock_and_count_active_supply(p_owner_id);
    v_plan_id := public._get_effective_merchant_plan_id(p_owner_id);
    select active_listing_limit into v_listing_limit from public.merchant_subscription_plans where id = v_plan_id;
    if v_listing_limit is not null and v_active_count >= v_listing_limit then
      raise exception 'active_listing_limit_reached: your current plan does not allow another active listing/Skill/Task right now';
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

-- ────────────────────────────────────────────────────────────
-- Pause / resume (Available only). Resume re-checks the cap exactly
-- like publish does -- a transition INTO active, not just the first
-- one, must never be allowed to exceed the combined limit.
-- ────────────────────────────────────────────────────────────
create or replace function public.pause_barter_skill_task_post(
  p_owner_id uuid, p_post_id uuid, p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_post public.barter_skill_task_posts;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;

  select * into v_post from public.barter_skill_task_posts where id = p_post_id for update;
  if v_post is null or v_post.owner_id <> p_owner_id then raise exception 'post not found or not owned by caller'; end if;
  perform public._validate_skill_task_post_transition(v_post.status, 'paused', v_post.direction);

  update public.barter_skill_task_posts set status = 'paused' where id = p_post_id;
  insert into public.barter_skill_task_post_history (post_id, actor_user_id, actor_role, event_type, previous_status, new_status)
  values (p_post_id, p_owner_id, 'owner', 'post_paused', v_post.status, 'paused');

  return jsonb_build_object('post_id', p_post_id, 'status', 'paused');
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
  v_post public.barter_skill_task_posts;
  v_active_count int;
  v_plan_id text;
  v_listing_limit int;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;

  perform public._assert_kyc_approved(p_owner_id, 'self');

  select * into v_post from public.barter_skill_task_posts where id = p_post_id for update;
  if v_post is null or v_post.owner_id <> p_owner_id then raise exception 'post not found or not owned by caller'; end if;
  perform public._validate_skill_task_post_transition(v_post.status, 'active', v_post.direction);

  if not v_post.is_test then
    v_active_count := public._lock_and_count_active_supply(p_owner_id);
    v_plan_id := public._get_effective_merchant_plan_id(p_owner_id);
    select active_listing_limit into v_listing_limit from public.merchant_subscription_plans where id = v_plan_id;
    if v_listing_limit is not null and v_active_count >= v_listing_limit then
      raise exception 'active_listing_limit_reached: your current plan does not allow another active listing/Skill/Task right now';
    end if;
  end if;

  update public.barter_skill_task_posts set status = 'active' where id = p_post_id;
  insert into public.barter_skill_task_post_history (post_id, actor_user_id, actor_role, event_type, previous_status, new_status)
  values (p_post_id, p_owner_id, 'owner', 'post_resumed', v_post.status, 'active');

  return jsonb_build_object('post_id', p_post_id, 'status', 'active');
end;
$$;

-- ────────────────────────────────────────────────────────────
-- Close (Looking-For only) -- immediately cancels every linked
-- proposed/countered agreement in the same transaction, reusing
-- cancel_barter_agreement() itself (the post owner IS party_a for
-- every source-linked agreement by construction, see the source-link
-- migration, so calling it with p_owner_id as the actor is genuine
-- reuse, not a workaround). History is never deleted.
-- ────────────────────────────────────────────────────────────
create or replace function public.close_barter_skill_task_post(
  p_owner_id uuid, p_post_id uuid, p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_post public.barter_skill_task_posts;
  v_agreement record;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;

  select * into v_post from public.barter_skill_task_posts where id = p_post_id for update;
  if v_post is null or v_post.owner_id <> p_owner_id then raise exception 'post not found or not owned by caller'; end if;
  perform public._validate_skill_task_post_transition(v_post.status, 'closed', v_post.direction);

  update public.barter_skill_task_posts set status = 'closed' where id = p_post_id;
  insert into public.barter_skill_task_post_history (post_id, actor_user_id, actor_role, event_type, previous_status, new_status)
  values (p_post_id, p_owner_id, 'owner', 'post_closed', v_post.status, 'closed');

  for v_agreement in
    select id from public.barter_agreements
    where source_skill_task_post_id = p_post_id and status in ('proposed', 'countered')
  loop
    perform public.cancel_barter_agreement(p_owner_id, v_agreement.id, 'originating request closed', null);
  end loop;

  return jsonb_build_object('post_id', p_post_id, 'status', 'closed');
end;
$$;

create or replace function public.archive_barter_skill_task_post(
  p_owner_id uuid, p_post_id uuid, p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_post public.barter_skill_task_posts;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;

  select * into v_post from public.barter_skill_task_posts where id = p_post_id for update;
  if v_post is null or v_post.owner_id <> p_owner_id then raise exception 'post not found or not owned by caller'; end if;
  perform public._validate_skill_task_post_transition(v_post.status, 'archived', v_post.direction);

  update public.barter_skill_task_posts set status = 'archived' where id = p_post_id;
  insert into public.barter_skill_task_post_history (post_id, actor_user_id, actor_role, event_type, previous_status, new_status)
  values (p_post_id, p_owner_id, 'owner', 'post_archived', v_post.status, 'archived');

  return jsonb_build_object('post_id', p_post_id, 'status', 'archived');
end;
$$;

-- Clones public terms into a NEW draft row -- never mutates the
-- original. Mirrors repost_marketplace_request's exact pattern.
create or replace function public.repost_barter_skill_task_post(
  p_owner_id uuid, p_post_id uuid, p_idempotency_key text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source public.barter_skill_task_posts;
  v_new_id uuid;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;

  select * into v_source from public.barter_skill_task_posts where id = p_post_id;
  if v_source is null or v_source.owner_id <> p_owner_id then raise exception 'post not found or not owned by caller'; end if;

  insert into public.barter_skill_task_posts (
    owner_id, kind, direction, title, description, category_id, subcategory_id, delivery_mode, province, city,
    exclusions, materials_arrangement, evidence_expectations, desired_exchange_notes,
    wants_item, wants_skill, wants_task, wants_cash_adjustment,
    availability_notes, preferred_start_date, preferred_start_time, deadline, expected_duration_notes,
    reposted_from_post_id, status
  )
  select
    owner_id, kind, direction, title, description, category_id, subcategory_id, delivery_mode, province, city,
    exclusions, materials_arrangement, evidence_expectations, desired_exchange_notes,
    wants_item, wants_skill, wants_task, wants_cash_adjustment,
    availability_notes, preferred_start_date, preferred_start_time, deadline, expected_duration_notes,
    p_post_id, 'draft'
  from public.barter_skill_task_posts where id = p_post_id
  returning id into v_new_id;

  insert into public.barter_skill_task_post_history (post_id, actor_user_id, actor_role, event_type, new_status, metadata)
  values (v_new_id, p_owner_id, 'owner', 'post_reposted', 'draft', jsonb_build_object('reposted_from_post_id', p_post_id));

  return v_new_id;
end;
$$;

-- ────────────────────────────────────────────────────────────
-- Post-level reporting -- mirrors report_profile() exactly.
-- ────────────────────────────────────────────────────────────
create or replace function public.report_barter_skill_task_post(
  p_reporter_id uuid,
  p_post_id uuid,
  p_reason text,
  p_description text default null,
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
  v_owner_id uuid;
  v_report_id uuid;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  if p_reporter_id is null then raise exception 'not authenticated'; end if;

  select owner_id into v_owner_id from public.barter_skill_task_posts where id = p_post_id;
  if v_owner_id is null then raise exception 'post not found'; end if;
  if v_owner_id = p_reporter_id then raise exception 'you cannot report your own post'; end if;
  if p_reason not in ('harassment', 'scam_fraud', 'inappropriate_content', 'impersonation', 'spam', 'prohibited_content', 'other') then
    raise exception 'invalid report reason';
  end if;

  v_request_hash := md5(coalesce(p_post_id::text, '') || '|' || coalesce(p_reason, '') || '|' || coalesce(p_description, ''));
  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_reporter_id and operation = 'report_barter_skill_task_post' and idempotency_key = p_idempotency_key;
    if found then
      if v_idem.request_hash is distinct from v_request_hash then raise exception 'idempotency key already used with a different request'; end if;
      return v_idem.result;
    end if;
  end if;

  insert into public.barter_skill_task_post_reports (reporter_id, post_id, reason, description)
  values (p_reporter_id, p_post_id, p_reason, p_description)
  returning id into v_report_id;

  v_result := jsonb_build_object('report_id', v_report_id, 'status', 'open');
  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_reporter_id, 'report_barter_skill_task_post', p_idempotency_key, v_request_hash, v_result);
  end if;
  return v_result;
end;
$$;

-- ────────────────────────────────────────────────────────────
-- Admin suspend -- idempotent: only captures pre_suspend_status on a
-- real non-suspended -> suspended transition; a repeat call while
-- already suspended is a safe no-op that never overwrites the
-- captured value or writes a second contradictory history row.
-- ────────────────────────────────────────────────────────────
create or replace function public.admin_suspend_barter_skill_task_post(
  p_admin_id uuid, p_post_id uuid, p_reason text, p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_post public.barter_skill_task_posts;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  if p_reason is null or length(trim(p_reason)) = 0 then raise exception 'a reason is required'; end if;

  select * into v_post from public.barter_skill_task_posts where id = p_post_id for update;
  if v_post is null then raise exception 'post not found'; end if;

  if v_post.status = 'suspended' then
    return jsonb_build_object('post_id', p_post_id, 'status', 'suspended', 'idempotent_replay', true);
  end if;

  perform public._validate_skill_task_post_transition(v_post.status, 'suspended', v_post.direction);

  update public.barter_skill_task_posts
  set status = 'suspended', pre_suspend_status = v_post.status
  where id = p_post_id;

  insert into public.barter_skill_task_post_history (post_id, actor_user_id, actor_role, event_type, previous_status, new_status, reason)
  values (p_post_id, p_admin_id, 'admin', 'post_suspended', v_post.status, 'suspended', p_reason);

  return jsonb_build_object('post_id', p_post_id, 'status', 'suspended');
end;
$$;

-- ────────────────────────────────────────────────────────────
-- Admin restore -- requires status='suspended' and a legal
-- restorable pre_suspend_status. Restoring to 'active' re-checks the
-- cap exactly like publish/resume; if the cap is full, the post stays
-- suspended and a clear normalized error is returned rather than
-- silently exceeding the cap or restoring into a different status.
-- ────────────────────────────────────────────────────────────
create or replace function public.admin_restore_barter_skill_task_post(
  p_admin_id uuid, p_post_id uuid, p_reason text, p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_post public.barter_skill_task_posts;
  v_active_count int;
  v_plan_id text;
  v_listing_limit int;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  if p_reason is null or length(trim(p_reason)) = 0 then raise exception 'a reason is required'; end if;

  select * into v_post from public.barter_skill_task_posts where id = p_post_id for update;
  if v_post is null then raise exception 'post not found'; end if;
  if v_post.status <> 'suspended' then raise exception 'post is not currently suspended'; end if;
  if v_post.pre_suspend_status is null or v_post.pre_suspend_status not in ('active', 'paused', 'offers_received') then
    raise exception 'post has no valid restorable prior status';
  end if;

  if v_post.pre_suspend_status = 'active' and v_post.direction = 'available' and not v_post.is_test then
    v_active_count := public._lock_and_count_active_supply(v_post.owner_id);
    v_plan_id := public._get_effective_merchant_plan_id(v_post.owner_id);
    select active_listing_limit into v_listing_limit from public.merchant_subscription_plans where id = v_plan_id;
    if v_listing_limit is not null and v_active_count >= v_listing_limit then
      raise exception 'active_listing_limit_reached: this post cannot be restored to active right now -- the owner''s current plan is at capacity. It remains suspended; retry once capacity is available.';
    end if;
  end if;

  update public.barter_skill_task_posts
  set status = v_post.pre_suspend_status, pre_suspend_status = null
  where id = p_post_id;

  insert into public.barter_skill_task_post_history (post_id, actor_user_id, actor_role, event_type, previous_status, new_status, reason)
  values (p_post_id, p_admin_id, 'admin', 'post_restored', 'suspended', v_post.pre_suspend_status, p_reason);

  return jsonb_build_object('post_id', p_post_id, 'status', v_post.pre_suspend_status);
end;
$$;

revoke all on function public._validate_skill_task_content(text[]) from public, anon, authenticated;
revoke all on function public._validate_skill_task_post_transition(barter_skill_task_post_status, barter_skill_task_post_status, text) from public, anon, authenticated;
revoke all on function public._lock_and_count_active_supply(uuid) from public, anon, authenticated;
revoke all on function public.save_barter_skill_task_post_draft(uuid, uuid, text, text, text, text, text, text, text, text, text, text, text, text, boolean, boolean, boolean, boolean, text, date, time, date, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.update_barter_skill_task_post(uuid, uuid, text, text, text, text, text, text, text, text, text, text, date, time, date, text, text) from public, anon, authenticated;
revoke all on function public.publish_barter_skill_task_post(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.pause_barter_skill_task_post(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.resume_barter_skill_task_post(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.close_barter_skill_task_post(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.archive_barter_skill_task_post(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.repost_barter_skill_task_post(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.report_barter_skill_task_post(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.admin_suspend_barter_skill_task_post(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.admin_restore_barter_skill_task_post(uuid, uuid, text, text) from public, anon, authenticated;

grant execute on function public._validate_skill_task_content(text[]) to service_role;
grant execute on function public._validate_skill_task_post_transition(barter_skill_task_post_status, barter_skill_task_post_status, text) to service_role;
grant execute on function public._lock_and_count_active_supply(uuid) to service_role;
grant execute on function public.save_barter_skill_task_post_draft(uuid, uuid, text, text, text, text, text, text, text, text, text, text, text, text, boolean, boolean, boolean, boolean, text, date, time, date, text, jsonb, text) to service_role;
grant execute on function public.update_barter_skill_task_post(uuid, uuid, text, text, text, text, text, text, text, text, text, text, date, time, date, text, text) to service_role;
grant execute on function public.publish_barter_skill_task_post(uuid, uuid, text) to service_role;
grant execute on function public.pause_barter_skill_task_post(uuid, uuid, text) to service_role;
grant execute on function public.resume_barter_skill_task_post(uuid, uuid, text) to service_role;
grant execute on function public.close_barter_skill_task_post(uuid, uuid, text) to service_role;
grant execute on function public.archive_barter_skill_task_post(uuid, uuid, text) to service_role;
grant execute on function public.repost_barter_skill_task_post(uuid, uuid, text) to service_role;
grant execute on function public.report_barter_skill_task_post(uuid, uuid, text, text, text) to service_role;
grant execute on function public.admin_suspend_barter_skill_task_post(uuid, uuid, text, text) to service_role;
grant execute on function public.admin_restore_barter_skill_task_post(uuid, uuid, text, text) to service_role;
