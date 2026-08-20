-- ============================================================
-- Unity -- Merchant Subscription Tiers V2 -- scheduled publishing
-- (Pro/Elite only, Section 3-4). Server-authoritative: a persisted row
-- + a secret-authenticated sweep executed the same way every other
-- reconciliation job in this codebase runs
-- (/api/internal/expire-marketplace-requests,
-- /api/internal/subscriptions/apply-due) -- never a browser timer.
-- Entitlement is checked TWICE: once at scheduling time (route layer)
-- and again at execution time (this migration's executor), since the
-- merchant's plan may have changed in between.
-- ============================================================

do $$
begin
  if not exists (select 1 from pg_type where typname = 'scheduled_publication_status') then
    create type scheduled_publication_status as enum ('pending', 'executed', 'blocked', 'cancelled');
  end if;
end$$;

create table if not exists public.merchant_scheduled_publications (
  id              uuid primary key default gen_random_uuid(),
  merchant_id     uuid not null references public.profiles(id),
  entity_type     text not null check (entity_type in ('listing', 'marketplace_request', 'barter_skill_task_post')),
  entity_id       uuid not null,
  scheduled_at    timestamptz not null,
  status          scheduled_publication_status not null default 'pending',
  block_reason    text,
  created_at      timestamptz not null default now(),
  executed_at     timestamptz,
  idempotency_key text,
  constraint merchant_scheduled_publications_future_only check (scheduled_at > created_at)
);

create index if not exists merchant_scheduled_publications_due_idx
  on public.merchant_scheduled_publications(scheduled_at)
  where status = 'pending';

create index if not exists merchant_scheduled_publications_merchant_idx
  on public.merchant_scheduled_publications(merchant_id, created_at);

alter table public.merchant_scheduled_publications enable row level security;

create policy "merchant_scheduled_publications: own read"
  on public.merchant_scheduled_publications for select
  using (merchant_id = auth.uid());

create policy "merchant_scheduled_publications: admin read"
  on public.merchant_scheduled_publications for select
  using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));

-- No client write policies -- schedule_listing_publication() /
-- cancel_scheduled_publication() / execute_due_scheduled_publications()
-- below are the only mutation paths.

create or replace function public.schedule_entity_publication(
  p_merchant_id uuid,
  p_entity_type text,
  p_entity_id uuid,
  p_scheduled_at timestamptz,
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
  v_owned boolean;
  v_new_id uuid;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_merchant_id is null then
    raise exception 'merchant id is required';
  end if;
  if p_entity_type not in ('listing', 'marketplace_request', 'barter_skill_task_post') then
    raise exception 'invalid entity type: %', p_entity_type;
  end if;
  if p_scheduled_at <= now() then
    raise exception 'scheduled_at must be in the future';
  end if;

  v_request_hash := md5(coalesce(p_merchant_id::text,'') || '|' || coalesce(p_entity_type,'') || '|' || coalesce(p_entity_id::text,'') || '|' || coalesce(p_scheduled_at::text,''));
  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_merchant_id and operation = 'schedule_entity_publication' and idempotency_key = p_idempotency_key;
    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  -- Ownership + eligible-status check, per entity type. Listings must
  -- already be draft or paused (draft: awaiting first go-live; paused:
  -- a merchant-initiated resume timed for later). Marketplace requests
  -- and Skill/Task posts must be draft.
  if p_entity_type = 'listing' then
    select exists (select 1 from public.listings where id = p_entity_id and merchant_id = p_merchant_id and status in ('draft', 'paused')) into v_owned;
  elsif p_entity_type = 'marketplace_request' then
    select exists (select 1 from public.marketplace_requests where id = p_entity_id and requester_id = p_merchant_id and status = 'draft') into v_owned;
  else
    select exists (select 1 from public.barter_skill_task_posts where id = p_entity_id and owner_id = p_merchant_id and status = 'draft') into v_owned;
  end if;

  if not v_owned then
    raise exception 'entity not found, not owned by caller, or not currently in a schedulable status';
  end if;

  insert into public.merchant_scheduled_publications (merchant_id, entity_type, entity_id, scheduled_at, idempotency_key)
  values (p_merchant_id, p_entity_type, p_entity_id, p_scheduled_at, p_idempotency_key)
  returning id into v_new_id;

  v_result := jsonb_build_object('schedule_id', v_new_id, 'status', 'pending', 'scheduled_at', p_scheduled_at);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_merchant_id, 'schedule_entity_publication', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

revoke all on function public.schedule_entity_publication(uuid, text, uuid, timestamptz, text) from public, anon, authenticated;
grant execute on function public.schedule_entity_publication(uuid, text, uuid, timestamptz, text) to service_role;

create or replace function public.cancel_scheduled_publication(
  p_merchant_id uuid,
  p_schedule_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.merchant_scheduled_publications;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;

  select * into v_row from public.merchant_scheduled_publications where id = p_schedule_id for update;
  if v_row is null or v_row.merchant_id <> p_merchant_id then
    raise exception 'schedule not found or not owned by caller';
  end if;
  if v_row.status <> 'pending' then
    raise exception 'only a pending schedule can be cancelled';
  end if;

  update public.merchant_scheduled_publications set status = 'cancelled' where id = p_schedule_id;
  return jsonb_build_object('schedule_id', p_schedule_id, 'status', 'cancelled');
end;
$$;

revoke all on function public.cancel_scheduled_publication(uuid, uuid) from public, anon, authenticated;
grant execute on function public.cancel_scheduled_publication(uuid, uuid) to service_role;

-- ────────────────────────────────────────────────────────────
-- execute_due_scheduled_publications -- the sweep. Idempotent by
-- construction (only ever processes status='pending' rows; a rerun
-- finds nothing left to do). Revalidates EVERYTHING at execution time
-- -- ownership, plan entitlement, KYC/publication_frozen/cap (via the
-- canonical publish RPCs themselves, never a re-implemented weaker
-- check) -- and NEVER deactivates another entity to make room; if the
-- cap is full, this schedule is simply marked blocked with a reason.
-- ────────────────────────────────────────────────────────────
create or replace function public.execute_due_scheduled_publications(p_limit int default 50)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
  v_plan_id text;
  v_advanced_tools boolean;
  v_block_reason text;
  v_processed int := 0;
  v_executed int := 0;
  v_blocked int := 0;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;

  for v_row in
    select * from public.merchant_scheduled_publications
    where status = 'pending' and scheduled_at <= now()
    order by scheduled_at asc
    limit p_limit
    for update skip locked
  loop
    v_processed := v_processed + 1;
    v_block_reason := null;

    -- Re-check the Pro/Elite scheduled-publishing entitlement fresh
    -- (Section 3: "If Starter by execution time: do not publish").
    v_plan_id := public._get_effective_merchant_plan_id(v_row.merchant_id);
    select advanced_tools_enabled into v_advanced_tools from public.merchant_subscription_plans where id = v_plan_id;

    if not coalesce(v_advanced_tools, false) then
      v_block_reason := 'plan_no_longer_eligible';
    end if;

    if v_block_reason is null then
      begin
        if v_row.entity_type = 'listing' then
          declare
            v_status listing_status;
          begin
            select status into v_status from public.listings where id = v_row.entity_id;
            if v_status = 'paused' then
              perform public.merchant_resume_listing(v_row.merchant_id, v_row.entity_id);
            elsif v_status = 'pending' then
              perform public.activate_listing(v_row.entity_id, v_row.merchant_id);
            else
              v_block_reason := 'listing_no_longer_schedulable_status_' || coalesce(v_status::text, 'unknown');
            end if;
          end;
        elsif v_row.entity_type = 'marketplace_request' then
          perform public.publish_marketplace_request(v_row.merchant_id, v_row.entity_id);
        else
          perform public.publish_barter_skill_task_post(v_row.merchant_id, v_row.entity_id);
        end if;
      exception when others then
        v_block_reason := left(sqlerrm, 200);
      end;
    end if;

    if v_block_reason is null then
      update public.merchant_scheduled_publications set status = 'executed', executed_at = now() where id = v_row.id;
      v_executed := v_executed + 1;
    else
      update public.merchant_scheduled_publications set status = 'blocked', block_reason = v_block_reason where id = v_row.id;
      v_blocked := v_blocked + 1;
    end if;
  end loop;

  return jsonb_build_object('processed', v_processed, 'executed', v_executed, 'blocked', v_blocked);
end;
$$;

revoke all on function public.execute_due_scheduled_publications(int) from public, anon, authenticated;
grant execute on function public.execute_due_scheduled_publications(int) to service_role;
