-- ============================================================
-- Unity -- D2 First-Party Event Analytics Foundation.
--
-- Append-only, first-party behavioral telemetry. No PII, no raw search
-- text, no IP address, no device/browser fingerprint, no cross-site
-- tracking, no third-party analytics provider. Writes go only through
-- record_analytics_event() (service_role only, SECURITY DEFINER) --
-- browser anon/authenticated keys can neither INSERT nor SELECT this
-- table directly, matching every other analytics-adjacent table in this
-- codebase (search_demand_aggregates, merchant_ai_usage_events).
--
-- event_name is allowlisted by a CHECK constraint -- an unknown event
-- name can never reach this table even if the ingestion route's own
-- application-level allowlist were ever bypassed. occurred_at is always
-- server-set (now()); no client-supplied timestamp is ever trusted as
-- authoritative.
-- ============================================================

create table if not exists public.analytics_events (
  id                   uuid primary key default gen_random_uuid(),
  -- Caller-supplied idempotency key (client UUID or server-generated) --
  -- the sole ingestion dedupe boundary, enforced by the unique index
  -- below and the RPC's own ON CONFLICT DO NOTHING.
  event_id             uuid not null,
  event_name           text not null check (event_name in (
    'page_view',
    'signup_started',
    'signup_completed',
    'search_started',
    'search_results_viewed',
    'search_zero_results',
    'search_refined',
    'listing_viewed',
    'listing_creation_started',
    'listing_published',
    'rental_checkout_started',
    'booking_created',
    'order_checkout_started',
    'order_created',
    'kyc_started',
    'kyc_submitted'
  )),
  event_version        smallint not null default 1 check (event_version > 0),
  -- Required for client-originated behavioral events; null for
  -- server-originated events with no browser session concept (e.g. an
  -- admin activating a listing). Never a permanent identifier -- see
  -- src/lib/analytics/session.ts's 30-minute inactivity rotation.
  session_id           uuid,
  -- Derived server-side ONLY (src/lib/supabase/require-admin.ts's
  -- getRequestProfile()) -- a client-supplied actor_state claim is never
  -- read or trusted by the ingestion route.
  actor_state          text check (actor_state is null or actor_state in ('anonymous', 'authenticated', 'merchant', 'admin')),
  -- Sanitized route path only -- no query string, no hash, bounded length.
  route_path           text check (route_path is null or char_length(route_path) <= 200),
  entity_type          text check (entity_type is null or entity_type in ('listing', 'booking', 'order')),
  entity_id            uuid,
  metadata             jsonb not null default '{}'::jsonb,
  -- Three-state, never silently collapsed to "real": 'real' and 'test'
  -- require an authoritative server-derived signal (e.g. the related
  -- listing's is_test column); everything else stays 'unknown' rather
  -- than falsely implying known-real activity (Section 8).
  data_classification  text not null default 'unknown' check (data_classification in ('real', 'test', 'unknown')),
  -- Server-authoritative event time -- never accepted from the client.
  occurred_at          timestamptz not null default now(),
  received_at          timestamptz not null default now()
);

-- Idempotency boundary -- a retried client send (e.g. a flaky
-- sendBeacon/fetch retry) with the same event_id is a no-op, never a
-- duplicate row.
create unique index if not exists analytics_events_event_id_key on public.analytics_events(event_id);

-- Append-heavy telemetry -- kept to the indexes actually needed for the
-- admin Behavior & Conversion queries (period filtering, per-event
-- counts, per-session funnel joins, classification exclusion, and
-- entity-scoped lookups), not an index per column.
create index if not exists analytics_events_occurred_at_idx on public.analytics_events(occurred_at);
create index if not exists analytics_events_event_name_occurred_at_idx on public.analytics_events(event_name, occurred_at);
create index if not exists analytics_events_session_id_occurred_at_idx on public.analytics_events(session_id, occurred_at);
create index if not exists analytics_events_classification_occurred_at_idx on public.analytics_events(data_classification, occurred_at);
create index if not exists analytics_events_entity_idx on public.analytics_events(entity_type, entity_id, occurred_at);

alter table public.analytics_events enable row level security;

-- Admin-only read via RLS (defense in depth) -- the real read path for
-- /admin/analytics is the service-role client (src/lib/admin/route-helpers.ts),
-- which bypasses RLS entirely, same as every other admin analytics query
-- in this codebase.
create policy "analytics_events: admin read"
  on public.analytics_events for select
  using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));

-- No insert/update/delete policy of any kind -- record_analytics_event()
-- below is the only writer, and it is service_role only. Browser
-- anon/authenticated clients can never write to this table directly.

create or replace function public.record_analytics_event(
  p_event_id uuid,
  p_event_name text,
  p_session_id uuid default null,
  p_actor_state text default null,
  p_route_path text default null,
  p_entity_type text default null,
  p_entity_id uuid default null,
  p_metadata jsonb default '{}'::jsonb,
  p_data_classification text default 'unknown'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'record_analytics_event is service_role only';
  end if;

  insert into public.analytics_events (
    event_id, event_name, session_id, actor_state, route_path,
    entity_type, entity_id, metadata, data_classification
  )
  values (
    p_event_id, p_event_name, p_session_id, p_actor_state, p_route_path,
    p_entity_type, p_entity_id, coalesce(p_metadata, '{}'::jsonb), coalesce(p_data_classification, 'unknown')
  )
  on conflict (event_id) do nothing;
end;
$$;

revoke all on function public.record_analytics_event(uuid, text, uuid, text, text, text, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.record_analytics_event(uuid, text, uuid, text, text, text, uuid, jsonb, text) to service_role;

-- Bounded retention -- behavioral telemetry is a rolling analytics
-- input, not a permanent ledger. Callable on demand, no cron
-- dependency, mirrors cleanup_search_demand_aggregates()'s exact shape.
create or replace function public.cleanup_analytics_events(p_older_than interval default interval '365 days')
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  if auth.role() <> 'service_role' then
    raise exception 'cleanup_analytics_events is service_role only';
  end if;

  delete from public.analytics_events where occurred_at < (now() - p_older_than);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.cleanup_analytics_events(interval) from public, anon, authenticated;
grant execute on function public.cleanup_analytics_events(interval) to service_role;
