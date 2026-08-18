-- ============================================================
-- Unity -- Personalization V1
--
-- Deterministic, privacy-conscious personalization. No ML, no
-- behavioral Search reranking, no Advertising targeting effect.
--
-- Schema is deliberately minimal (2 tables, not the larger set
-- sketched in the product brief) after auditing existing structures:
--   - No save/watchlist table exists anywhere in the repo yet, and
--     none is introduced here (per the brief: "do not invent a large
--     separate watchlist subsystem if one does not exist" -- V1 skips
--     the save/unsave signal entirely rather than building one from
--     scratch as a side effect of personalization).
--   - Completed-transaction affinity is computed live, at
--     recommendation time, by reading the EXISTING orders/bookings/
--     barter_agreements/rent_to_buy_agreements tables directly (their
--     own canonical status enums + is_test semantics are authoritative
--     already -- no duplication, no new table).
--   - Explicit preferences live on one settings row per user, not a
--     generic key/value events table.
--   - Views are stored as a compact PER-(user,entity) AGGREGATE (not
--     one row per page load), which is what naturally gives us the
--     required duplicate-view cap and avoids unbounded row growth from
--     reloads.
--
-- RLS follows this codebase's established convention for user-owned
-- data (see barter_agreements, merchant_subscriptions): owner-only
-- SELECT via auth.uid(), zero client INSERT/UPDATE/DELETE policies --
-- every mutation goes through a SECURITY DEFINER RPC, service-role
-- only, which itself re-validates auth.uid() = the target user.
-- ============================================================

-- ── user_personalization_settings ──────────────────────────────
-- One row per user, upserted on first preference/enable-state write.
-- Absence of a row means: personalization_enabled defaults true (per
-- the approved product decision), no explicit preferences set yet.
create table if not exists public.user_personalization_settings (
  user_id                     uuid primary key references public.profiles(id) on delete cascade,
  personalization_enabled     boolean not null default true,
  preferred_modes             text[] not null default '{}',
  preferred_categories        text[] not null default '{}',
  preferred_barter_kinds      text[] not null default '{}',
  interested_looking_for      boolean not null default false,
  interested_rtb              boolean not null default false,
  preferred_province          text,
  preferred_city              text,
  -- Reset boundary (Section 38/39 of the brief): behavioral signals
  -- older than this timestamp are ignored when computing
  -- recommendations. NULL = no reset has ever happened.
  personalization_reset_at    timestamptz,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  constraint user_personalization_settings_modes_check check (
    preferred_modes <@ array['buy', 'rent', 'barter']::text[]
  ),
  constraint user_personalization_settings_kinds_check check (
    preferred_barter_kinds <@ array['item', 'skill', 'task']::text[]
  )
);

create or replace function public.touch_personalization_settings_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger user_personalization_settings_touch_updated_at
  before update on public.user_personalization_settings
  for each row execute procedure public.touch_personalization_settings_updated_at();

alter table public.user_personalization_settings enable row level security;

create policy "user_personalization_settings: own read"
  on public.user_personalization_settings for select
  using (user_id = auth.uid());

-- No client insert/update/delete policy -- see the RPCs below.

-- ── user_personalization_views ─────────────────────────────────
-- Compact aggregate: one row per (user, entity), not one row per
-- page load. view_count is capped in application logic when scoring
-- (Section 59) so repeated refreshes cannot dominate a profile.
create table if not exists public.user_personalization_views (
  user_id                     uuid not null references public.profiles(id) on delete cascade,
  entity_type                 text not null check (entity_type in ('listing', 'marketplace_request', 'barter_skill_task_post')),
  entity_id                   uuid not null,
  mode                        text check (mode is null or mode in ('buy', 'rent', 'barter')),
  category                    text,
  kind                        text check (kind is null or kind in ('item', 'skill', 'task')),
  province                    text,
  city                        text,
  view_count                  integer not null default 1,
  first_viewed_at             timestamptz not null default now(),
  last_viewed_at              timestamptz not null default now(),
  primary key (user_id, entity_type, entity_id)
);

create index if not exists user_personalization_views_recency_idx
  on public.user_personalization_views(user_id, last_viewed_at desc);

alter table public.user_personalization_views enable row level security;

create policy "user_personalization_views: own read"
  on public.user_personalization_views for select
  using (user_id = auth.uid());

-- No client insert/update/delete policy -- see the RPCs below.

-- ── personalization_recommendation_events ──────────────────────
-- Minimal aggregate impression/click instrumentation, mirroring the
-- existing ad_impressions/ad_clicks shape (admin-only read, RPC-only
-- write, no fingerprinting). Kept as ONE small table -- personalization
-- has none of Advertising's billing/reconciliation weight, so it does
-- not need Advertising's two-table split.
create table if not exists public.personalization_recommendation_events (
  id                          uuid primary key default gen_random_uuid(),
  event_type                  text not null check (event_type in ('impression', 'click')),
  module                      text not null,
  reason_code                 text not null,
  entity_type                 text not null check (entity_type in ('listing', 'marketplace_request', 'barter_skill_task_post')),
  entity_id                   uuid not null,
  position                    integer,
  -- Nullable: anonymous impressions/clicks are recorded without an
  -- identity, exactly like ad_impressions.viewer_id.
  user_id                     uuid references public.profiles(id) on delete set null,
  occurred_at                 timestamptz not null default now()
);

create index if not exists personalization_recommendation_events_occurred_idx
  on public.personalization_recommendation_events(occurred_at desc);

alter table public.personalization_recommendation_events enable row level security;

create policy "personalization_recommendation_events: admin read"
  on public.personalization_recommendation_events for select
  using (exists (
    select 1 from public.profiles
    where profiles.id = auth.uid() and profiles.role = 'admin'
  ));

-- No client insert/update/delete policy -- see the RPC below.

-- ============================================================
-- RPCs -- all SECURITY DEFINER, service-role only. Each re-validates
-- auth.uid() = the target user id supplied by the caller (the Next.js
-- API route already establishes the authenticated session and passes
-- the session's own user id -- this is defense in depth, not the only
-- check).
-- ============================================================

create or replace function public.update_personalization_settings(
  p_user_id uuid,
  p_personalization_enabled boolean default null,
  p_preferred_modes text[] default null,
  p_preferred_categories text[] default null,
  p_preferred_barter_kinds text[] default null,
  p_interested_looking_for boolean default null,
  p_interested_rtb boolean default null,
  p_preferred_province text default null,
  p_preferred_city text default null
)
returns public.user_personalization_settings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.user_personalization_settings;
begin
  if p_user_id is null or p_user_id <> auth.uid() then
    raise exception 'update_personalization_settings: caller may only update their own settings';
  end if;

  insert into public.user_personalization_settings (user_id)
  values (p_user_id)
  on conflict (user_id) do nothing;

  update public.user_personalization_settings
  set
    personalization_enabled = coalesce(p_personalization_enabled, personalization_enabled),
    preferred_modes = coalesce(p_preferred_modes, preferred_modes),
    preferred_categories = coalesce(p_preferred_categories, preferred_categories),
    preferred_barter_kinds = coalesce(p_preferred_barter_kinds, preferred_barter_kinds),
    interested_looking_for = coalesce(p_interested_looking_for, interested_looking_for),
    interested_rtb = coalesce(p_interested_rtb, interested_rtb),
    preferred_province = coalesce(p_preferred_province, preferred_province),
    preferred_city = coalesce(p_preferred_city, preferred_city)
  where user_id = p_user_id
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.update_personalization_settings(uuid, boolean, text[], text[], text[], boolean, boolean, text, text) from public, anon, authenticated;
grant execute on function public.update_personalization_settings(uuid, boolean, text[], text[], text[], boolean, boolean, text, text) to service_role;

-- Records (or bumps) one aggregate view row. Caps effective weight by
-- capping the stored counter itself at 5 -- a 6th+ view of the same
-- item still refreshes last_viewed_at (recency), but stops adding
-- further count-based weight (Section 59).
create or replace function public.record_personalization_view(
  p_user_id uuid,
  p_entity_type text,
  p_entity_id uuid,
  p_mode text default null,
  p_category text default null,
  p_kind text default null,
  p_province text default null,
  p_city text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_user_id is null or p_user_id <> auth.uid() then
    raise exception 'record_personalization_view: caller may only record their own views';
  end if;

  insert into public.user_personalization_views (
    user_id, entity_type, entity_id, mode, category, kind, province, city
  )
  values (
    p_user_id, p_entity_type, p_entity_id, p_mode, p_category, p_kind, p_province, p_city
  )
  on conflict (user_id, entity_type, entity_id) do update
  set
    view_count = least(public.user_personalization_views.view_count + 1, 5),
    last_viewed_at = now(),
    -- Refresh denormalized context in case it changed (e.g. category
    -- edit) -- last-write-wins, matching every other denormalized
    -- snapshot convention in this codebase.
    mode = coalesce(excluded.mode, public.user_personalization_views.mode),
    category = coalesce(excluded.category, public.user_personalization_views.category),
    kind = coalesce(excluded.kind, public.user_personalization_views.kind),
    province = coalesce(excluded.province, public.user_personalization_views.province),
    city = coalesce(excluded.city, public.user_personalization_views.city);
end;
$$;

revoke all on function public.record_personalization_view(uuid, text, uuid, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.record_personalization_view(uuid, text, uuid, text, text, text, text, text) to service_role;

-- Reset behavioral history (Section 38/39): wipes the compact view
-- aggregate and bumps personalization_reset_at, WITHOUT touching any
-- financial/transaction source record. Completed-transaction affinity
-- is computed live at recommendation time and is filtered by this
-- cutoff (occurred_at/completed-at > personalization_reset_at) rather
-- than being deleted, since there is nothing to delete -- there was
-- never a stored copy of that signal.
create or replace function public.reset_personalization_history(
  p_user_id uuid
)
returns public.user_personalization_settings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.user_personalization_settings;
begin
  if p_user_id is null or p_user_id <> auth.uid() then
    raise exception 'reset_personalization_history: caller may only reset their own history';
  end if;

  delete from public.user_personalization_views where user_id = p_user_id;

  insert into public.user_personalization_settings (user_id, personalization_reset_at)
  values (p_user_id, now())
  on conflict (user_id) do update
  set personalization_reset_at = now()
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.reset_personalization_history(uuid) from public, anon, authenticated;
grant execute on function public.reset_personalization_history(uuid) to service_role;

-- Idempotent anonymous-to-authenticated merge (Section 40/41). Each
-- anonymous view event carries a client-generated stable dedupe key
-- (entity_type + entity_id -- entity identity IS the dedupe key here,
-- since the target is the same aggregate table record-per-view uses).
-- Re-running this with the same payload after sign-in a second time
-- is a no-op beyond bumping last_viewed_at, matching
-- record_personalization_view's own upsert semantics exactly -- this
-- function is a thin batch wrapper around it, not a separate code path.
create or replace function public.merge_anonymous_personalization_views(
  p_user_id uuid,
  p_events jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event jsonb;
  v_count integer := 0;
begin
  if p_user_id is null or p_user_id <> auth.uid() then
    raise exception 'merge_anonymous_personalization_views: caller may only merge into their own account';
  end if;

  if p_events is null or jsonb_typeof(p_events) <> 'array' then
    return 0;
  end if;

  for v_event in select * from jsonb_array_elements(p_events)
  loop
    if (v_event->>'entityType') is null or (v_event->>'entityId') is null then
      continue;
    end if;

    insert into public.user_personalization_views (
      user_id, entity_type, entity_id, mode, category, kind, province, city
    )
    values (
      p_user_id,
      v_event->>'entityType',
      (v_event->>'entityId')::uuid,
      v_event->>'mode',
      v_event->>'category',
      v_event->>'kind',
      v_event->>'province',
      v_event->>'city'
    )
    on conflict (user_id, entity_type, entity_id) do update
    set
      view_count = least(public.user_personalization_views.view_count + 1, 5),
      last_viewed_at = greatest(public.user_personalization_views.last_viewed_at, now())
    ;
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke all on function public.merge_anonymous_personalization_views(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.merge_anonymous_personalization_views(uuid, jsonb) to service_role;

-- Recommendation-performance instrumentation. Anonymous impressions/
-- clicks pass p_user_id = null; no identity is ever inferred.
create or replace function public.record_personalization_recommendation_event(
  p_event_type text,
  p_module text,
  p_reason_code text,
  p_entity_type text,
  p_entity_id uuid,
  p_position integer default null,
  p_user_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_user_id is not null and p_user_id <> auth.uid() then
    raise exception 'record_personalization_recommendation_event: caller may only attribute their own identity';
  end if;

  insert into public.personalization_recommendation_events (
    event_type, module, reason_code, entity_type, entity_id, position, user_id
  )
  values (
    p_event_type, p_module, p_reason_code, p_entity_type, p_entity_id, p_position, p_user_id
  );
end;
$$;

revoke all on function public.record_personalization_recommendation_event(text, text, text, text, uuid, integer, uuid) from public, anon, authenticated;
grant execute on function public.record_personalization_recommendation_event(text, text, text, text, uuid, integer, uuid) to service_role;

-- Deterministic retention cleanup (Section 45/73) -- no cron
-- dependency, callable on demand (a scheduled invocation can be added
-- later via whatever job runner the deployment target already uses).
-- Deletes behavioral rows older than the retention horizon. Never
-- touches settings (explicit preferences are not "behavioral") or any
-- financial/transaction record.
create or replace function public.cleanup_personalization_views(
  p_older_than interval default interval '90 days'
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  delete from public.user_personalization_views
  where last_viewed_at < now() - p_older_than;
  get diagnostics v_deleted = row_count;

  delete from public.personalization_recommendation_events
  where occurred_at < now() - p_older_than;

  return v_deleted;
end;
$$;

revoke all on function public.cleanup_personalization_views(interval) from public, anon, authenticated;
grant execute on function public.cleanup_personalization_views(interval) to service_role;
