-- ============================================================
-- Account status, user account history, and generic admin notes
-- (Step 9, public-test MVP — Admin Operations Dashboard)
-- ============================================================
-- profiles.account_status is the minimum normalized status the brief
-- asked for -- active / restricted / suspended, nothing larger. It is a
-- privileged field (see protect_profile_privileged_fields below), so it
-- is safe to keep on the publicly-readable `profiles` row rather than a
-- separate table: the "profiles: public read" policy already exposes
-- role/kyc_status the same way, and account_status is not sensitive.
--
-- user_account_history mirrors identity_verification_history exactly
-- (admin-only read, immutable via the existing prevent_row_mutation()
-- trigger) rather than trying to force this into the listing-scoped
-- admin_action_history table, whose `listing_id not null` makes it
-- unusable for a user-scoped action (confirmed by audit).
--
-- admin_notes is the generic, entity-agnostic notes table the brief
-- asked for, since no existing table covers arbitrary entity types --
-- every existing "notes" column (moderation_notes, reviewer_notes) is
-- specific to one decision table.
--
-- Idempotency reuses idempotency_keys exactly as established elsewhere
-- in this codebase -- scoped by the acting ADMIN's own profile id, never
-- by the target user id (which would violate the FK to profiles.id in
-- some future entity_type, and is the same class of bug
-- 20260801000005_payment_idempotency_fk_fix.sql already fixed once).
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

do $$ begin
  create type profile_account_status as enum ('active', 'restricted', 'suspended');
exception when duplicate_object then null; end $$;

alter table public.profiles
  add column if not exists account_status profile_account_status not null default 'active',
  add column if not exists status_reason text,
  add column if not exists status_changed_at timestamptz,
  add column if not exists status_changed_by uuid references public.profiles(id);

-- ─────────────────────────────────────────
-- user_account_history — admin-only, immutable audit trail
-- ─────────────────────────────────────────
create table if not exists public.user_account_history (
  id              uuid primary key default uuid_generate_v4(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  admin_id        uuid not null references public.profiles(id),
  action_type     text not null check (action_type in ('restricted', 'suspended', 'restored')),
  previous_status profile_account_status not null,
  new_status      profile_account_status not null,
  -- user_reason is safe to ever surface to the affected user (support
  -- correspondence, a future account-status banner); internal_note never is.
  user_reason     text,
  internal_note   text,
  created_at      timestamptz not null default now()
);

create index if not exists user_account_history_user_idx
  on public.user_account_history(user_id, created_at);

alter table public.user_account_history enable row level security;

create policy "user_account_history: admin read"
  on public.user_account_history for select
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

drop trigger if exists user_account_history_immutable_trg on public.user_account_history;
create trigger user_account_history_immutable_trg
  before update or delete on public.user_account_history
  for each row execute procedure public.prevent_row_mutation();

-- ─────────────────────────────────────────
-- admin_notes — generic, append-only, entity-agnostic
-- ─────────────────────────────────────────
create table if not exists public.admin_notes (
  id          uuid primary key default uuid_generate_v4(),
  entity_type text not null check (entity_type in ('user', 'listing', 'booking')),
  entity_id   uuid not null,
  admin_id    uuid not null references public.profiles(id),
  note        text not null check (char_length(note) <= 2000),
  created_at  timestamptz not null default now()
);

create index if not exists admin_notes_entity_idx
  on public.admin_notes(entity_type, entity_id, created_at);

alter table public.admin_notes enable row level security;

create policy "admin_notes: admin read"
  on public.admin_notes for select
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

drop trigger if exists admin_notes_immutable_trg on public.admin_notes;
create trigger admin_notes_immutable_trg
  before update or delete on public.admin_notes
  for each row execute procedure public.prevent_row_mutation();

-- ─────────────────────────────────────────
-- Extend the existing privileged-fields trigger to also protect
-- account_status / status_reason / status_changed_at / status_changed_by
-- -- CREATE OR REPLACE on an already-applied function, per this
-- codebase's established convention for trigger changes.
-- ─────────────────────────────────────────
create or replace function public.protect_profile_privileged_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then
    new.role := old.role;
    new.kyc_status := old.kyc_status;

    if pg_trigger_depth() <= 1 then
      new.unity_score := old.unity_score;
    end if;

    new.is_affiliate := old.is_affiliate;
    new.affiliate_code := old.affiliate_code;

    new.account_status := old.account_status;
    new.status_reason := old.status_reason;
    new.status_changed_at := old.status_changed_at;
    new.status_changed_by := old.status_changed_by;
  end if;
  return new;
end;
$$;

-- ─────────────────────────────────────────
-- set_user_account_status — one RPC covering all three transitions
-- (restrict / suspend / restore). One function rather than three for the
-- same reason decide_moderation/decide_ownership_verification are single
-- functions: the guard + history write is identical, only the target
-- status and idempotency operation name differ, and the operation name
-- (built from p_action) keeps each transition's idempotency scope
-- distinct.
-- ─────────────────────────────────────────
create or replace function public.set_user_account_status(
  p_user_id uuid,
  p_admin_id uuid,
  p_action text,
  p_user_reason text,
  p_internal_note text,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_operation text;
  v_request_hash text;
  v_idem record;
  v_previous_status profile_account_status;
  v_new_status profile_account_status;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_admin_id is null then
    raise exception 'not authenticated';
  end if;
  if p_action not in ('restricted', 'suspended', 'restored') then
    raise exception 'invalid account status action';
  end if;
  if p_user_id = p_admin_id and p_action in ('restricted', 'suspended') then
    raise exception 'an administrator cannot restrict or suspend their own account';
  end if;

  v_new_status := case p_action
    when 'restricted' then 'restricted'::profile_account_status
    when 'suspended' then 'suspended'::profile_account_status
    else 'active'::profile_account_status
  end;

  v_operation := 'set_user_account_status:' || p_action;
  v_request_hash := md5(
    coalesce(p_user_id::text, '') || '|' || coalesce(p_user_reason, '') || '|' || coalesce(p_internal_note, '')
  );

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_admin_id and operation = v_operation and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select account_status into v_previous_status from public.profiles where id = p_user_id;
  if v_previous_status is null then
    raise exception 'user not found';
  end if;

  update public.profiles set
    account_status = v_new_status,
    status_reason = case when p_action = 'restored' then null else p_user_reason end,
    status_changed_at = v_now,
    status_changed_by = p_admin_id
  where id = p_user_id;

  insert into public.user_account_history (
    user_id, admin_id, action_type, previous_status, new_status, user_reason, internal_note
  ) values (
    p_user_id, p_admin_id, p_action, v_previous_status, v_new_status, p_user_reason, p_internal_note
  );

  v_result := jsonb_build_object('user_id', p_user_id, 'account_status', v_new_status);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_admin_id, v_operation, p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

-- ─────────────────────────────────────────
-- add_admin_note — plain append, kept as an RPC (rather than a raw
-- service-role insert from the route) only so it gets the same
-- idempotency-key handling as every other admin mutation, for free.
-- ─────────────────────────────────────────
create or replace function public.add_admin_note(
  p_entity_type text,
  p_entity_id uuid,
  p_admin_id uuid,
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
  if p_entity_type not in ('user', 'listing', 'booking') then
    raise exception 'invalid entity type';
  end if;
  if p_note is null or length(trim(p_note)) = 0 then
    raise exception 'note cannot be empty';
  end if;

  v_request_hash := md5(coalesce(p_entity_type, '') || '|' || coalesce(p_entity_id::text, '') || '|' || coalesce(p_note, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_admin_id and operation = 'add_admin_note' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  insert into public.admin_notes (entity_type, entity_id, admin_id, note)
  values (p_entity_type, p_entity_id, p_admin_id, p_note)
  returning id into v_note_id;

  v_result := jsonb_build_object('id', v_note_id, 'entity_type', p_entity_type, 'entity_id', p_entity_id);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_admin_id, 'add_admin_note', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

revoke all on function public.set_user_account_status(uuid, uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.set_user_account_status(uuid, uuid, text, text, text, text) to service_role;

revoke all on function public.add_admin_note(text, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.add_admin_note(text, uuid, uuid, text, text) to service_role;
