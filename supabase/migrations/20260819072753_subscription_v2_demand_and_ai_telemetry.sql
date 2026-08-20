-- ============================================================
-- Unity -- Merchant Subscription Tiers V2 -- demand intelligence +
-- merchant AI assistant telemetry.
--
-- Both tables are pure AGGREGATE/AUDIT telemetry: no user_id, no IP, no
-- device id, no fingerprint, no raw query text on the demand side; no
-- prompt/response persistence on the AI side (Section 40: usage
-- metadata only). Neither table is read by Search Ranking or
-- Personalization -- both remain fully separate, unmodified systems.
-- ============================================================

-- ── search_demand_aggregates ── one row per (day, mode, category,
-- province, is_test) bucket, incremented via upsert. Deliberately
-- coarse (no city, no raw query text) to keep buckets large enough that
-- a merchant can never infer one individual's search activity from the
-- displayed trend -- see the privacy-threshold check in
-- src/lib/subscriptions/demand.ts, applied on READ, not write.
create table if not exists public.search_demand_aggregates (
  id                  uuid primary key default gen_random_uuid(),
  day                 date not null,
  mode                text check (mode is null or mode in ('buy', 'rent', 'barter')),
  category            text,
  province             text,
  is_test             boolean not null default false,
  search_count        integer not null default 0 check (search_count >= 0),
  zero_result_count   integer not null default 0 check (zero_result_count >= 0),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (day, mode, category, province, is_test)
);

create index if not exists search_demand_aggregates_day_idx on public.search_demand_aggregates(day);

create or replace function public.touch_search_demand_aggregates_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger search_demand_aggregates_touch_updated_at
  before update on public.search_demand_aggregates
  for each row execute procedure public.touch_search_demand_aggregates_updated_at();

alter table public.search_demand_aggregates enable row level security;

-- Pro/Elite entitlement is enforced in the API route (it must also
-- exclude is_test and apply the volume threshold), not by RLS alone --
-- but there is still no broad authenticated SELECT policy here: reads
-- go through the demand-insights route (service-role), matching every
-- other analytics-adjacent table in this codebase.
create policy "search_demand_aggregates: admin read"
  on public.search_demand_aggregates for select
  using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));

-- No client insert/update/delete policy -- record_search_demand_event() below is the only writer.

create or replace function public.record_search_demand_event(
  p_mode text default null,
  p_category text default null,
  p_province text default null,
  p_zero_result boolean default false,
  p_is_test boolean default false
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.search_demand_aggregates (day, mode, category, province, is_test, search_count, zero_result_count)
  values (current_date, p_mode, p_category, p_province, p_is_test, 1, case when p_zero_result then 1 else 0 end)
  on conflict (day, mode, category, province, is_test) do update
  set search_count = public.search_demand_aggregates.search_count + 1,
      zero_result_count = public.search_demand_aggregates.zero_result_count + case when p_zero_result then 1 else 0 end;
end;
$$;

revoke all on function public.record_search_demand_event(text, text, text, boolean, boolean) from public, anon, authenticated;
grant execute on function public.record_search_demand_event(text, text, text, boolean, boolean) to service_role;

-- Bounded retention -- demand aggregates are trend data, not a
-- permanent ledger. Callable on demand, no cron dependency, mirrors
-- cleanup_personalization_views()'s exact shape.
create or replace function public.cleanup_search_demand_aggregates(p_older_than interval default interval '180 days')
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  delete from public.search_demand_aggregates where day < (current_date - p_older_than);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.cleanup_search_demand_aggregates(interval) from public, anon, authenticated;
grant execute on function public.cleanup_search_demand_aggregates(interval) to service_role;

-- ── merchant_ai_usage_events ── minimal, safe usage/audit records
-- (Section 40). No prompt/response text is ever stored here.
create table if not exists public.merchant_ai_usage_events (
  id               uuid primary key default gen_random_uuid(),
  merchant_id      uuid not null references public.profiles(id),
  plan_id          text not null references public.merchant_subscription_plans(id),
  capability       text not null check (capability in ('listing_assistant', 'analytics_assistant')),
  provider         text not null default 'anthropic',
  model            text,
  status           text not null check (status in ('succeeded', 'failed', 'rate_limited', 'provider_unavailable')),
  input_tokens     integer,
  output_tokens    integer,
  latency_ms       integer,
  created_at       timestamptz not null default now()
);

create index if not exists merchant_ai_usage_events_merchant_idx on public.merchant_ai_usage_events(merchant_id, created_at);

alter table public.merchant_ai_usage_events enable row level security;

create policy "merchant_ai_usage_events: own read"
  on public.merchant_ai_usage_events for select
  using (merchant_id = auth.uid());

create policy "merchant_ai_usage_events: admin read"
  on public.merchant_ai_usage_events for select
  using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));

-- No client insert/update/delete policy -- record_merchant_ai_usage_event() below is the only writer.

create or replace function public.record_merchant_ai_usage_event(
  p_merchant_id uuid,
  p_plan_id text,
  p_capability text,
  p_status text,
  p_provider text default 'anthropic',
  p_model text default null,
  p_input_tokens integer default null,
  p_output_tokens integer default null,
  p_latency_ms integer default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.merchant_ai_usage_events
    (merchant_id, plan_id, capability, provider, model, status, input_tokens, output_tokens, latency_ms)
  values
    (p_merchant_id, p_plan_id, p_capability, p_provider, p_model, p_status, p_input_tokens, p_output_tokens, p_latency_ms);
end;
$$;

revoke all on function public.record_merchant_ai_usage_event(uuid, text, text, text, text, text, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.record_merchant_ai_usage_event(uuid, text, text, text, text, text, integer, integer, integer) to service_role;
