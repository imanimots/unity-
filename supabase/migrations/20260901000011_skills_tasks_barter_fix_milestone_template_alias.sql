-- ============================================================
-- Fix-forward correction, found via live smoke testing immediately
-- after 20260901000009 was applied: save_barter_skill_task_post_draft()
-- used `jsonb_array_elements(p_milestone_templates) as v_item` --
-- aliasing the FROM-clause output column to the SAME name as the
-- declared plpgsql variable v_item, which Postgres rejects as
-- ambiguous ("column reference v_item is ambiguous... could refer to
-- either a PL/pgSQL variable or a table column", code 42702). Same
-- signature, so CREATE OR REPLACE is safe -- 20260901000009 itself is
-- left untouched.
-- ============================================================

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
    select sum((t->>'weight_percent')::numeric) into v_weight_sum
    from jsonb_array_elements(p_milestone_templates) as t;
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
-- create or replace preserves the existing grants (service_role only).
