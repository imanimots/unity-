-- ============================================================
-- E7 -- Support Centre admin actor integrity
-- ============================================================
-- E6 (20261031120000) closed the DATABASE PRIVILEGE boundary: only
-- service_role may EXECUTE any of the 9 privileged Support Centre RPCs
-- at all. That is a necessary but separate control from this one.
--
-- This migration closes a different gap: INTERNAL ACTOR VALIDATION.
-- Every one of the 9 RPCs is called with `p_admin_id` sourced, in every
-- real caller, from `gate.requester.userId` after
-- requireAdminForRoute() -> requireAdmin() has already confirmed that
-- id belongs to a `profiles` row with role = 'admin' (traced fresh in
-- src/lib/supabase/require-admin.ts -- that is the application's ENTIRE
-- admin model: role = 'admin', no account_status condition). Until now,
-- 8 of the 9 functions trusted `p_admin_id` as a bare value and never
-- independently re-checked that trust inside the database itself -- an
-- unnecessary dependency of a privileged database mutation on the
-- correctness of application-layer code it has no way to verify at
-- call time. Only create_support_case already did this correctly.
--
-- Re-traced line-by-line against the live, already-applied
-- 20261026000000_support_centre_schema.sql immediately before writing
-- this migration:
--   - create_support_case: already checks
--     `exists (select 1 from public.profiles where id = p_admin_id and role = 'admin')`
--     -- NOT touched here, nothing to fix.
--   - assign_support_case: checks that role on p_assignee_admin_id (the
--     TARGET), never on p_admin_id (the ACTOR) -- fixed below, the
--     existing assignee check is left exactly as-is alongside it.
--   - change_support_case_priority, update_support_case_status,
--     escalate_support_case, resolve_support_case, close_support_case,
--     reopen_support_case, add_support_case_note: no profiles-role
--     validation of p_admin_id at all -- fixed below.
--
-- The fix is the smallest auditable option: the identical inline check
-- create_support_case already uses, duplicated verbatim into each of
-- the other 8 functions, in the same position (immediately after the
-- existing `p_admin_id is null` check, before any other validation).
-- No shared/new callable helper function is introduced -- a broadly
-- callable SECURITY DEFINER helper would itself be a new privileged
-- surface purely to save a few duplicated lines of SQL; security is
-- more important than deduplication here.
--
-- Every other line of every function body below is byte-for-byte
-- identical to 20261026000000_support_centre_schema.sql: same
-- `security definer set search_path = public`, same idempotency-key
-- handling, same `for update` row locking, same history-insert
-- pairing, same returned shape, same existing exception messages and
-- ordering for every OTHER check. The actor-validation `raise
-- exception` happens before any SELECT/INSERT/UPDATE statement in every
-- function, so a rejected call produces zero mutations and zero
-- history rows -- no partial operation is possible. No new exception
-- message is introduced beyond the literal string already used by
-- create_support_case ('not authorized'), so no new route-level error
-- mapping is required -- it is already handled identically to the
-- existing `auth.role()` guard's own 'not authorized' message.
--
-- This is a forward migration, not an edit of the already-applied
-- 20261026000000_support_centre_schema.sql -- per this project's own
-- migration-history discipline, an applied migration is never
-- rewritten.
--
-- Postgres preserves a function's existing GRANT/REVOKE ACL across
-- CREATE OR REPLACE FUNCTION when the argument-type signature is
-- unchanged (documented behavior: "ownership and permissions of the
-- function do not change"). None of the 8 signatures below change.
-- That alone would already keep E6's service_role-only EXECUTE grant
-- intact. This migration does not rely on that alone: it defensively
-- re-asserts the exact same revoke/grant pair E6 established for each
-- of the 8 functions being redefined, immediately after each
-- redefinition. Both statements are idempotent and change nothing
-- different if privileges already match -- this turns E6's invariant
-- into something re-enforced on every migration run instead of merely
-- assumed to have survived. Apply via: GitHub integration only, per
-- standing project rule.
-- ============================================================

create or replace function public.assign_support_case(
  p_admin_id uuid,
  p_case_id uuid,
  p_assignee_admin_id uuid,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_case record;
  v_request_hash text;
  v_idem record;
  v_action text;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_admin_id is null then
    raise exception 'not authenticated';
  end if;
  if not exists (select 1 from public.profiles where id = p_admin_id and role = 'admin') then
    raise exception 'not authorized';
  end if;
  if not exists (select 1 from public.profiles where id = p_assignee_admin_id and role = 'admin') then
    raise exception 'assignee must be an admin';
  end if;

  v_request_hash := md5(coalesce(p_case_id::text, '') || '|' || coalesce(p_assignee_admin_id::text, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_admin_id and operation = 'assign_support_case' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select id, assigned_admin_id into v_case from public.support_cases where id = p_case_id for update;
  if v_case.id is null then
    raise exception 'support case not found';
  end if;

  v_action := case when v_case.assigned_admin_id is null then 'assigned' else 'reassigned' end;

  update public.support_cases set assigned_admin_id = p_assignee_admin_id where id = p_case_id;

  insert into public.support_case_history (case_id, actor_admin_id, action, previous_state, new_state, idempotency_key)
  values (p_case_id, p_admin_id, v_action, jsonb_build_object('assigned_admin_id', v_case.assigned_admin_id), jsonb_build_object('assigned_admin_id', p_assignee_admin_id), p_idempotency_key);

  v_result := jsonb_build_object('id', p_case_id, 'assigned_admin_id', p_assignee_admin_id);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_admin_id, 'assign_support_case', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

revoke all on function public.assign_support_case(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.assign_support_case(uuid, uuid, uuid, text) to service_role;

create or replace function public.change_support_case_priority(
  p_admin_id uuid,
  p_case_id uuid,
  p_priority support_case_priority,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_case record;
  v_request_hash text;
  v_idem record;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_admin_id is null then
    raise exception 'not authenticated';
  end if;
  if not exists (select 1 from public.profiles where id = p_admin_id and role = 'admin') then
    raise exception 'not authorized';
  end if;

  v_request_hash := md5(coalesce(p_case_id::text, '') || '|' || coalesce(p_priority::text, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_admin_id and operation = 'change_support_case_priority' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select id, priority into v_case from public.support_cases where id = p_case_id for update;
  if v_case.id is null then
    raise exception 'support case not found';
  end if;

  update public.support_cases set priority = p_priority where id = p_case_id;

  insert into public.support_case_history (case_id, actor_admin_id, action, previous_state, new_state, idempotency_key)
  values (p_case_id, p_admin_id, 'priority_changed', jsonb_build_object('priority', v_case.priority), jsonb_build_object('priority', p_priority), p_idempotency_key);

  v_result := jsonb_build_object('id', p_case_id, 'priority', p_priority);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_admin_id, 'change_support_case_priority', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

revoke all on function public.change_support_case_priority(uuid, uuid, support_case_priority, text) from public, anon, authenticated;
grant execute on function public.change_support_case_priority(uuid, uuid, support_case_priority, text) to service_role;

create or replace function public.update_support_case_status(
  p_admin_id uuid,
  p_case_id uuid,
  p_target_status support_case_status,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_case record;
  v_request_hash text;
  v_idem record;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_admin_id is null then
    raise exception 'not authenticated';
  end if;
  if not exists (select 1 from public.profiles where id = p_admin_id and role = 'admin') then
    raise exception 'not authorized';
  end if;
  if p_target_status not in ('open', 'in_progress', 'waiting_on_user') then
    raise exception 'use the dedicated escalate/resolve/close/reopen actions for this transition';
  end if;

  v_request_hash := md5(coalesce(p_case_id::text, '') || '|' || coalesce(p_target_status::text, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_admin_id and operation = 'update_support_case_status' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select id, status into v_case from public.support_cases where id = p_case_id for update;
  if v_case.id is null then
    raise exception 'support case not found';
  end if;
  if v_case.status not in ('open', 'in_progress', 'waiting_on_user') then
    raise exception 'this case must be reopened before its status can change again';
  end if;

  update public.support_cases set status = p_target_status where id = p_case_id;

  insert into public.support_case_history (case_id, actor_admin_id, action, previous_state, new_state, idempotency_key)
  values (p_case_id, p_admin_id, 'status_changed', jsonb_build_object('status', v_case.status), jsonb_build_object('status', p_target_status), p_idempotency_key);

  v_result := jsonb_build_object('id', p_case_id, 'status', p_target_status);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_admin_id, 'update_support_case_status', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

revoke all on function public.update_support_case_status(uuid, uuid, support_case_status, text) from public, anon, authenticated;
grant execute on function public.update_support_case_status(uuid, uuid, support_case_status, text) to service_role;

create or replace function public.escalate_support_case(
  p_admin_id uuid,
  p_case_id uuid,
  p_reason text,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_case record;
  v_request_hash text;
  v_idem record;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_admin_id is null then
    raise exception 'not authenticated';
  end if;
  if not exists (select 1 from public.profiles where id = p_admin_id and role = 'admin') then
    raise exception 'not authorized';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'an escalation reason is required';
  end if;

  v_request_hash := md5(coalesce(p_case_id::text, '') || '|' || coalesce(p_reason, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_admin_id and operation = 'escalate_support_case' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select id, status into v_case from public.support_cases where id = p_case_id for update;
  if v_case.id is null then
    raise exception 'support case not found';
  end if;
  if v_case.status not in ('open', 'in_progress', 'waiting_on_user') then
    raise exception 'only an active, non-escalated case can be escalated';
  end if;

  update public.support_cases
  set status = 'escalated', escalated = true, escalated_at = now(), escalated_by = p_admin_id, escalation_reason = p_reason
  where id = p_case_id;

  insert into public.support_case_history (case_id, actor_admin_id, action, reason, previous_state, new_state, idempotency_key)
  values (p_case_id, p_admin_id, 'escalated', p_reason, jsonb_build_object('status', v_case.status), jsonb_build_object('status', 'escalated'), p_idempotency_key);

  v_result := jsonb_build_object('id', p_case_id, 'status', 'escalated');

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_admin_id, 'escalate_support_case', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

revoke all on function public.escalate_support_case(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.escalate_support_case(uuid, uuid, text, text) to service_role;

create or replace function public.resolve_support_case(
  p_admin_id uuid,
  p_case_id uuid,
  p_resolution_summary text,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_case record;
  v_request_hash text;
  v_idem record;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_admin_id is null then
    raise exception 'not authenticated';
  end if;
  if not exists (select 1 from public.profiles where id = p_admin_id and role = 'admin') then
    raise exception 'not authorized';
  end if;
  if p_resolution_summary is null or length(trim(p_resolution_summary)) = 0 then
    raise exception 'a resolution summary is required';
  end if;

  v_request_hash := md5(coalesce(p_case_id::text, '') || '|' || coalesce(p_resolution_summary, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_admin_id and operation = 'resolve_support_case' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select id, status into v_case from public.support_cases where id = p_case_id for update;
  if v_case.id is null then
    raise exception 'support case not found';
  end if;
  if v_case.status not in ('open', 'in_progress', 'waiting_on_user', 'escalated') then
    raise exception 'this case cannot be resolved from its current status';
  end if;

  update public.support_cases
  set status = 'resolved', resolution_summary = p_resolution_summary, resolved_by = p_admin_id, resolved_at = now()
  where id = p_case_id;

  insert into public.support_case_history (case_id, actor_admin_id, action, previous_state, new_state, idempotency_key)
  values (p_case_id, p_admin_id, 'resolved', jsonb_build_object('status', v_case.status), jsonb_build_object('status', 'resolved'), p_idempotency_key);

  v_result := jsonb_build_object('id', p_case_id, 'status', 'resolved');

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_admin_id, 'resolve_support_case', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

revoke all on function public.resolve_support_case(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.resolve_support_case(uuid, uuid, text, text) to service_role;

create or replace function public.close_support_case(
  p_admin_id uuid,
  p_case_id uuid,
  p_reason text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_case record;
  v_request_hash text;
  v_idem record;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_admin_id is null then
    raise exception 'not authenticated';
  end if;
  if not exists (select 1 from public.profiles where id = p_admin_id and role = 'admin') then
    raise exception 'not authorized';
  end if;

  v_request_hash := md5(coalesce(p_case_id::text, '') || '|' || coalesce(p_reason, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_admin_id and operation = 'close_support_case' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select id, status into v_case from public.support_cases where id = p_case_id for update;
  if v_case.id is null then
    raise exception 'support case not found';
  end if;
  if v_case.status = 'closed' then
    raise exception 'this case is already closed';
  end if;
  if v_case.status <> 'resolved' and (p_reason is null or length(trim(p_reason)) = 0) then
    raise exception 'a reason is required to close a case that has not been resolved';
  end if;

  update public.support_cases
  set status = 'closed', closed_by = p_admin_id, closed_at = now()
  where id = p_case_id;

  insert into public.support_case_history (case_id, actor_admin_id, action, reason, previous_state, new_state, idempotency_key)
  values (p_case_id, p_admin_id, 'closed', p_reason, jsonb_build_object('status', v_case.status), jsonb_build_object('status', 'closed'), p_idempotency_key);

  v_result := jsonb_build_object('id', p_case_id, 'status', 'closed');

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_admin_id, 'close_support_case', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

revoke all on function public.close_support_case(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.close_support_case(uuid, uuid, text, text) to service_role;

create or replace function public.reopen_support_case(
  p_admin_id uuid,
  p_case_id uuid,
  p_reason text,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_case record;
  v_request_hash text;
  v_idem record;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_admin_id is null then
    raise exception 'not authenticated';
  end if;
  if not exists (select 1 from public.profiles where id = p_admin_id and role = 'admin') then
    raise exception 'not authorized';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a reason is required to reopen a case';
  end if;

  v_request_hash := md5(coalesce(p_case_id::text, '') || '|' || coalesce(p_reason, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_admin_id and operation = 'reopen_support_case' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select id, status into v_case from public.support_cases where id = p_case_id for update;
  if v_case.id is null then
    raise exception 'support case not found';
  end if;
  if v_case.status not in ('resolved', 'closed') then
    raise exception 'only a resolved or closed case can be reopened';
  end if;

  update public.support_cases
  set status = 'open', reopened_by = p_admin_id, reopened_at = now()
  where id = p_case_id;

  insert into public.support_case_history (case_id, actor_admin_id, action, reason, previous_state, new_state, idempotency_key)
  values (p_case_id, p_admin_id, 'reopened', p_reason, jsonb_build_object('status', v_case.status), jsonb_build_object('status', 'open'), p_idempotency_key);

  v_result := jsonb_build_object('id', p_case_id, 'status', 'open');

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_admin_id, 'reopen_support_case', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

revoke all on function public.reopen_support_case(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.reopen_support_case(uuid, uuid, text, text) to service_role;

create or replace function public.add_support_case_note(
  p_admin_id uuid,
  p_case_id uuid,
  p_note text,
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
  v_note_id uuid;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_admin_id is null then
    raise exception 'not authenticated';
  end if;
  if not exists (select 1 from public.profiles where id = p_admin_id and role = 'admin') then
    raise exception 'not authorized';
  end if;
  if p_note is null or length(trim(p_note)) = 0 then
    raise exception 'note cannot be empty';
  end if;
  if not exists (select 1 from public.support_cases where id = p_case_id) then
    raise exception 'support case not found';
  end if;

  v_request_hash := md5(coalesce(p_case_id::text, '') || '|' || coalesce(p_note, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_admin_id and operation = 'add_support_case_note' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  insert into public.support_case_notes (case_id, admin_id, note)
  values (p_case_id, p_admin_id, p_note)
  returning id into v_note_id;

  insert into public.support_case_history (case_id, actor_admin_id, action, idempotency_key)
  values (p_case_id, p_admin_id, 'note_added', p_idempotency_key);

  v_result := jsonb_build_object('id', v_note_id, 'case_id', p_case_id);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_admin_id, 'add_support_case_note', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

revoke all on function public.add_support_case_note(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.add_support_case_note(uuid, uuid, text, text) to service_role;
