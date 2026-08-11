-- ============================================================
-- Clickable Customer Profiles -- minimal profile-report mechanism.
-- ============================================================
-- Audit found: no generic user-report system exists anywhere in this
-- codebase (only transaction disputes, which are booking/order/barter
-- scoped and not a "report this user" mechanism). Per Step P's explicit
-- allowance, this implements ONLY the minimal safe mechanism: a report
-- record + one RPC. No public visibility, admin-only handling. This is
-- deliberately NOT a moderation subsystem (no admin UI, no
-- status-workflow RPCs) -- reviewing/actioning reports is a follow-up,
-- not built here, to avoid the "STOP and report it as a separate
-- follow-up" scope boundary this task's own instructions set.
--
-- No changes are made to the `profiles` table itself, its RLS, or any
-- other existing schema. Blocking is deliberately NOT implemented here
-- (audit found no existing infrastructure and proper implementation
-- would touch many systems -- reported as a follow-up in the final
-- report, not built).
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

create table public.profile_reports (
  id                    uuid primary key default gen_random_uuid(),
  reporter_id           uuid not null references public.profiles(id),
  reported_profile_id   uuid not null references public.profiles(id),
  reason                text not null check (reason in ('harassment', 'scam_fraud', 'inappropriate_content', 'impersonation', 'spam', 'other')),
  description           text,
  status                text not null default 'open' check (status in ('open', 'reviewed', 'dismissed')),
  created_at            timestamptz not null default now(),
  check (reporter_id <> reported_profile_id)
);

create index profile_reports_reported_profile_id_idx on public.profile_reports(reported_profile_id);
create index profile_reports_reporter_id_created_at_idx on public.profile_reports(reporter_id, created_at);

alter table public.profile_reports enable row level security;
-- Deliberately zero client read/write policies -- fully RPC-gated,
-- matching disputes/barter_agreements/rent_to_buy_agreements' own
-- "no client write policy anywhere" convention. Admin visibility is a
-- follow-up (direct service-role query today, no admin UI yet).

create or replace function public.report_profile(
  p_reporter_id uuid,
  p_reported_profile_id uuid,
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
  v_report_id uuid;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_reporter_id is null then
    raise exception 'not authenticated';
  end if;
  if p_reported_profile_id is null then
    raise exception 'a reported profile is required';
  end if;
  if p_reporter_id = p_reported_profile_id then
    raise exception 'you cannot report your own profile';
  end if;
  if p_reason not in ('harassment', 'scam_fraud', 'inappropriate_content', 'impersonation', 'spam', 'other') then
    raise exception 'invalid report reason';
  end if;
  if not exists (select 1 from public.profiles where id = p_reported_profile_id) then
    raise exception 'reported profile not found';
  end if;

  v_request_hash := md5(coalesce(p_reported_profile_id::text, '') || '|' || coalesce(p_reason, '') || '|' || coalesce(p_description, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_reporter_id and operation = 'report_profile' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  insert into public.profile_reports (reporter_id, reported_profile_id, reason, description)
  values (p_reporter_id, p_reported_profile_id, p_reason, p_description)
  returning id into v_report_id;

  v_result := jsonb_build_object('report_id', v_report_id, 'status', 'open');

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_reporter_id, 'report_profile', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

revoke all on function public.report_profile(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.report_profile(uuid, uuid, text, text, text) to service_role;
