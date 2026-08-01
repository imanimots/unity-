-- ============================================================
-- Financial workflow RPCs (Financial Orchestrator hardening pass)
-- ============================================================
-- Both service_role only, matching every RPC in this schema. The
-- orchestrator (TypeScript) decides what step to run next; these RPCs
-- only persist that progress so it can be resumed after a crash, a lost
-- response, or a genuine provider timeout.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

-- ------------------------------------------------------------
-- START_OR_RESUME_FINANCIAL_WORKFLOW -- find-or-create by
-- (booking_id, workflow_type). A row already 'completed' is returned
-- as-is so the caller can short-circuit on its cached result without
-- repeating any provider call. A row 'failed_terminal' raises -- a
-- terminal failure must not be silently retried; the caller has to
-- handle that distinctly (matches the orchestrator's normalized error
-- codes, not a generic idempotency conflict).
-- ------------------------------------------------------------
create or replace function public.start_or_resume_financial_workflow(
  p_booking_id uuid,
  p_workflow_type text,
  p_provider text,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_workflow record;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;

  select id, status, current_step, retry_count, result, idempotency_key
  into v_workflow
  from public.financial_workflows
  where booking_id = p_booking_id and workflow_type = p_workflow_type
  for update;

  if v_workflow.id is null then
    insert into public.financial_workflows (booking_id, workflow_type, provider, status, idempotency_key)
    values (p_booking_id, p_workflow_type, p_provider, 'pending', p_idempotency_key)
    returning id, status, current_step, retry_count, result, idempotency_key into v_workflow;
  elsif v_workflow.status = 'failed_terminal' then
    raise exception 'financial workflow % for booking % has failed terminally and cannot be resumed', p_workflow_type, p_booking_id;
  elsif v_workflow.status = 'failed_retryable' then
    update public.financial_workflows
    set status = 'processing', retry_count = retry_count + 1, idempotency_key = coalesce(p_idempotency_key, idempotency_key)
    where id = v_workflow.id
    returning id, status, current_step, retry_count, result, idempotency_key into v_workflow;
  end if;

  return jsonb_build_object(
    'workflow_id', v_workflow.id,
    'status', v_workflow.status,
    'current_step', v_workflow.current_step,
    'retry_count', v_workflow.retry_count,
    'result', v_workflow.result
  );
end;
$$;

-- ------------------------------------------------------------
-- UPDATE_FINANCIAL_WORKFLOW_PROGRESS -- persists progress after each
-- step. Setting status='completed' also stamps completed_at.
-- ------------------------------------------------------------
create or replace function public.update_financial_workflow_progress(
  p_workflow_id uuid,
  p_status workflow_status,
  p_current_step text default null,
  p_last_error_code text default null,
  p_last_error_message text default null,
  p_result jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;

  if not exists (select 1 from public.financial_workflows where id = p_workflow_id) then
    raise exception 'financial workflow not found';
  end if;

  update public.financial_workflows set
    status = p_status,
    current_step = coalesce(p_current_step, current_step),
    last_error_code = p_last_error_code,
    last_error_message = p_last_error_message,
    result = coalesce(p_result, result),
    completed_at = case when p_status = 'completed' then now() else completed_at end
  where id = p_workflow_id;

  return jsonb_build_object('workflow_id', p_workflow_id, 'status', p_status);
end;
$$;

revoke all on function public.start_or_resume_financial_workflow(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.update_financial_workflow_progress(uuid, workflow_status, text, text, text, jsonb) from public, anon, authenticated;

grant execute on function public.start_or_resume_financial_workflow(uuid, text, text, text) to service_role;
grant execute on function public.update_financial_workflow_progress(uuid, workflow_status, text, text, text, jsonb) to service_role;
