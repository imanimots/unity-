-- ============================================================
-- Admin Control Centre -- Batch A2: Support Centre
-- ============================================================
-- NOT APPLIED. Implementation-only migration -- an independent review
-- gates applying this before any deployment (ADMIN-CONTROL-CENTRE-
-- BATCH-A2-SUPPORT-CENTRE-IMPLEMENTATION).
--
-- A real internal admin support-case workflow: support_cases (one row
-- per case) + support_case_notes (append-only internal notes, distinct
-- from the existing generic admin_notes table -- see note below) +
-- support_case_history (append-only audit trail). Mirrors the
-- disputes schema's conventions exactly (20260814000002/4/6):
-- SECURITY DEFINER / service_role-only RPCs, idempotency_keys reuse,
-- prevent_row_mutation() for append-only tables, admin-only RLS read
-- with zero client write policies.
--
-- support_case_notes is intentionally NOT the existing admin_notes
-- table: admin_notes is a lightweight, entity-agnostic annotation
-- table (used today on users/listings/bookings) with no case-specific
-- shape (no "formal case note" semantics, no dedicated RLS/history
-- wiring to a case lifecycle). The brief (Part 15) explicitly requires
-- these stay distinct concepts.
--
-- Case number is never COUNT(*)+1 (race-prone under concurrent
-- inserts) -- generate_support_case_number() draws from a real
-- Postgres sequence (nextval() is atomic/concurrency-safe) and the
-- column also carries its own UNIQUE constraint as a backstop.
--
-- Apply via: GitHub integration only (per standing project rule) --
-- NEVER Supabase CLI / SQL Editor / psql. This migration file must not
-- be applied as part of this phase.
-- ============================================================

-- ─────────────────────────────────────────
-- Enums
-- ─────────────────────────────────────────
do $$ begin
  create type support_case_category as enum (
    'account_access',
    'identity_kyc',
    'listing_ownership',
    'rental_booking',
    'buy_sell_order',
    'barter',
    'rent_to_buy',
    'looking_for',
    'payment',
    'deposit_refund',
    'payout',
    'subscription',
    'affiliate_ambassador',
    'advertising',
    'dispute_trust_safety',
    'privacy_popia',
    'technical_issue',
    'general_other'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type support_case_status as enum (
    'open', 'in_progress', 'waiting_on_user', 'escalated', 'resolved', 'closed'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type support_case_priority as enum ('low', 'normal', 'high', 'urgent');
exception when duplicate_object then null; end $$;

-- Bounded -- A2 is internal-admin-only (no customer-facing case
-- creation yet), so the only two real sources this phase can produce.
do $$ begin
  create type support_case_source as enum ('admin_created', 'system_generated');
exception when duplicate_object then null; end $$;

-- Bounded taxonomy for linked_entity_type -- the TS deep-link builder
-- (src/lib/support/deep-links.ts) switches over this exact same list,
-- so an unmapped/unsupported type can never produce an injected route;
-- it falls back to rendering id+type as plain text.
do $$ begin
  create type support_linked_entity_type as enum (
    'customer', 'merchant', 'listing', 'booking', 'order', 'barter',
    'rent_to_buy', 'looking_for', 'dispute', 'payout', 'subscription',
    'affiliate', 'advertising'
  );
exception when duplicate_object then null; end $$;

-- ─────────────────────────────────────────
-- Case number -- sequence-backed, concurrency-safe, immutable once set
-- ─────────────────────────────────────────
create sequence if not exists public.support_case_number_seq start 1;

create or replace function public.generate_support_case_number()
returns text
language sql
as $$
  select 'SUP-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('public.support_case_number_seq')::text, 6, '0');
$$;

-- ─────────────────────────────────────────
-- support_cases
-- ─────────────────────────────────────────
create table if not exists public.support_cases (
  id                    uuid primary key default uuid_generate_v4(),
  case_number           text not null unique default public.generate_support_case_number(),

  title                 text not null check (char_length(title) between 1 and 200),
  description           text not null default '' check (char_length(description) <= 4000),
  category              support_case_category not null,
  status                support_case_status not null default 'open',
  priority              support_case_priority not null default 'normal',
  source                support_case_source not null default 'admin_created',

  -- Either/both may be set -- a case can concern a customer, a
  -- merchant, or (rarely) both sides of the same transaction.
  customer_id           uuid references public.profiles(id),
  merchant_id           uuid references public.profiles(id),

  linked_entity_type    support_linked_entity_type,
  linked_entity_id      uuid,

  assigned_admin_id     uuid references public.profiles(id),
  created_by_admin_id   uuid not null references public.profiles(id),

  escalated             boolean not null default false,
  escalated_at          timestamptz,
  escalated_by          uuid references public.profiles(id),
  escalation_reason     text,

  resolution_summary    text,
  resolved_by           uuid references public.profiles(id),
  resolved_at           timestamptz,
  closed_by             uuid references public.profiles(id),
  closed_at             timestamptz,
  reopened_at           timestamptz,
  reopened_by           uuid references public.profiles(id),

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint support_cases_linked_entity_pair_chk check (
    (linked_entity_type is null and linked_entity_id is null) or
    (linked_entity_type is not null and linked_entity_id is not null)
  ),
  constraint support_cases_at_least_one_party_chk check (
    customer_id is not null or merchant_id is not null
  )
);

create index if not exists support_cases_status_idx on public.support_cases(status, created_at desc);
create index if not exists support_cases_priority_idx on public.support_cases(priority, created_at desc);
create index if not exists support_cases_assigned_idx on public.support_cases(assigned_admin_id, created_at desc);
create index if not exists support_cases_customer_idx on public.support_cases(customer_id, created_at desc);
create index if not exists support_cases_merchant_idx on public.support_cases(merchant_id, created_at desc);
create index if not exists support_cases_category_idx on public.support_cases(category);
create index if not exists support_cases_linked_entity_idx on public.support_cases(linked_entity_type, linked_entity_id);

create or replace function public.touch_support_case_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists support_cases_touch_updated_at on public.support_cases;
create trigger support_cases_touch_updated_at
  before update on public.support_cases
  for each row execute function public.touch_support_case_updated_at();

alter table public.support_cases enable row level security;

create policy "support_cases: admin read"
  on public.support_cases for select
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

-- Deliberately zero insert/update/delete policies -- every mutation
-- goes through the SECURITY DEFINER RPCs below (service_role only),
-- matching the disputes/barter_agreements fully-RPC-gated model.

-- ─────────────────────────────────────────
-- support_case_notes -- formal case notes, distinct from admin_notes
-- (see header). Append-only, internal-only, no edit/delete.
-- ─────────────────────────────────────────
create table if not exists public.support_case_notes (
  id          uuid primary key default uuid_generate_v4(),
  case_id     uuid not null references public.support_cases(id) on delete cascade,
  admin_id    uuid not null references public.profiles(id),
  note        text not null check (char_length(note) between 1 and 4000),
  created_at  timestamptz not null default now()
);

create index if not exists support_case_notes_case_idx on public.support_case_notes(case_id, created_at);

alter table public.support_case_notes enable row level security;

create policy "support_case_notes: admin read"
  on public.support_case_notes for select
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

drop trigger if exists support_case_notes_immutable_trg on public.support_case_notes;
create trigger support_case_notes_immutable_trg
  before update or delete on public.support_case_notes
  for each row execute function public.prevent_row_mutation();

-- ─────────────────────────────────────────
-- support_case_history -- durable append-only audit trail
-- ─────────────────────────────────────────
create table if not exists public.support_case_history (
  id              uuid primary key default uuid_generate_v4(),
  case_id         uuid not null references public.support_cases(id) on delete cascade,
  actor_admin_id  uuid references public.profiles(id),
  action          text not null check (action in (
    'case_created', 'assigned', 'reassigned', 'priority_changed',
    'status_changed', 'escalated', 'deescalated', 'note_added',
    'resolved', 'closed', 'reopened', 'linked_entity_changed'
  )),
  reason          text,
  previous_state  jsonb,
  new_state       jsonb,
  metadata        jsonb not null default '{}',
  idempotency_key text,
  created_at      timestamptz not null default now()
);

create index if not exists support_case_history_case_idx on public.support_case_history(case_id, created_at);

alter table public.support_case_history enable row level security;

create policy "support_case_history: admin read"
  on public.support_case_history for select
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

drop trigger if exists support_case_history_immutable_trg on public.support_case_history;
create trigger support_case_history_immutable_trg
  before update or delete on public.support_case_history
  for each row execute function public.prevent_row_mutation();

-- ============================================================
-- RPCs -- every mutation path: SECURITY DEFINER, service_role-only,
-- idempotency-keyed via the shared idempotency_keys table (keyed by
-- the ACTING ADMIN's id, never the case/target id -- same precedent
-- 20260801000005_payment_idempotency_fk_fix.sql established), row-
-- locked via `for update`, and always paired with a support_case_
-- history insert so a case can never change without a matching audit
-- row (Part 19 -- atomicity).
-- ============================================================

create or replace function public.create_support_case(
  p_admin_id uuid,
  p_title text,
  p_category support_case_category,
  p_description text default '',
  p_priority support_case_priority default 'normal',
  p_customer_id uuid default null,
  p_merchant_id uuid default null,
  p_linked_entity_type support_linked_entity_type default null,
  p_linked_entity_id uuid default null,
  p_source support_case_source default 'admin_created',
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
  v_case_id uuid;
  v_case_number text;
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
  if p_title is null or length(trim(p_title)) = 0 then
    raise exception 'title is required';
  end if;
  if p_customer_id is null and p_merchant_id is null then
    raise exception 'a support case requires at least one of customer_id or merchant_id';
  end if;
  if (p_linked_entity_type is null) <> (p_linked_entity_id is null) then
    raise exception 'linked_entity_type and linked_entity_id must be provided together';
  end if;

  v_request_hash := md5(coalesce(p_title, '') || '|' || coalesce(p_category::text, '') || '|' || coalesce(p_customer_id::text, '') || '|' || coalesce(p_merchant_id::text, '') || '|' || coalesce(p_linked_entity_type::text, '') || '|' || coalesce(p_linked_entity_id::text, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_admin_id and operation = 'create_support_case' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  insert into public.support_cases (
    title, description, category, priority, source,
    customer_id, merchant_id, linked_entity_type, linked_entity_id,
    created_by_admin_id, assigned_admin_id
  )
  values (
    trim(p_title), coalesce(p_description, ''), p_category, p_priority, p_source,
    p_customer_id, p_merchant_id, p_linked_entity_type, p_linked_entity_id,
    p_admin_id, p_admin_id
  )
  returning id, case_number into v_case_id, v_case_number;

  insert into public.support_case_history (case_id, actor_admin_id, action, new_state, idempotency_key)
  values (v_case_id, p_admin_id, 'case_created', jsonb_build_object('status', 'open', 'priority', p_priority, 'category', p_category), p_idempotency_key);

  v_result := jsonb_build_object('id', v_case_id, 'case_number', v_case_number, 'status', 'open');

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_admin_id, 'create_support_case', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

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

-- update_support_case_status -- the "soft" lifecycle moves only
-- (open / in_progress / waiting_on_user), never into/out of
-- escalated/resolved/closed. Those have their own dedicated RPCs below
-- so a mandatory reason/resolution-summary can be enforced server-side
-- (Part 17) rather than optionally on a generic status PATCH.
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

-- close_support_case -- the normal path is resolved -> closed (reason
-- optional). Closing directly from an active status ("closing without
-- resolution", Part 17) is also allowed but only with an explicit,
-- non-empty reason -- enforced here, not merely suggested in the UI.
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

-- add_support_case_note -- formal, append-only case note (see header
-- for why this is not the generic add_admin_note RPC).
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
