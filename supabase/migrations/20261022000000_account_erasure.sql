-- ============================================================
-- Account erasure / anonymization (POPIA right-to-erasure gap closure)
-- ============================================================
-- The live Privacy/POPIA pages already promise a right to "request
-- deletion" of personal information (subject to retention for legal,
-- fraud, dispute and operational purposes -- see the "Retention"
-- section of both pages). Nothing behind that promise exists yet.
--
-- A real hard DELETE of profiles/auth.users is not safe for any account
-- that has ever transacted: profiles.id references auth.users on
-- delete cascade, but bookings/orders/disputes/messages/reviews/
-- payments/etc. all reference profiles(id) with the default NO ACTION
-- (no cascade), and legal_acceptances is additionally protected by
-- prevent_row_mutation() (20260806000001), which blocks UPDATE/DELETE
-- for every role including service_role. docs/LEGAL_CONTENT_MAP.md's
-- own "Known limitations" section already documents this exact
-- interaction (auth.admin.deleteUser live-tested and failed with a
-- database error) and already recommends the resolution implemented
-- here: anonymize the profile in place, under a tombstoned (but never
-- deleted) user id, leaving every immutable audit/legal/financial
-- record intact and still FK-valid.
--
-- 'erased' is a new, terminal, one-way state of the EXISTING
-- profile_account_status enum (active/restricted/suspended) --
-- reusing the already-established two-tier creation/transaction gate
-- (src/lib/admin/account-status.ts, _assert_account_status_permits_*
-- below) rather than inventing a parallel mechanism. An erased account
-- can never create new activity and can never be transacted with, same
-- as a suspended one, but additionally has its identifying profile
-- fields scrubbed and can never be restored back to active -- which
-- requires one additional guard below, in the EXISTING
-- set_user_account_status RPC (20260808000001): that function's
-- 'restored' action had no check on the row's CURRENT status, so
-- without this guard an admin could call the ordinary restore action
-- against an already-erased profile and flip it back to 'active' under
-- its scrubbed "Deleted User" identity. CREATE OR REPLACE on an
-- already-applied function, same convention as the two guards above.
--
-- What this migration does NOT do: delete auth.users, delete profiles,
-- delete bookings/orders/disputes/reviews/messages/payments/payouts/
-- ledger_entries, or touch any immutable history/audit table. Those are
-- exactly the tables prevent_row_mutation() already protects, and nothing
-- here needs to override that -- the erasure RPC only ever touches
-- mutable "current state" rows (profiles, identity_verifications,
-- email_deliveries, listings, marketplace_requests,
-- barter_skill_task_posts), never an append-only history table.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

alter type profile_account_status add value if not exists 'erased';

-- ─────────────────────────────────────────
-- Extend the two existing cross-cutting account-status guards
-- (20260904000006_marketplace_request_account_status_hardening.sql) so
-- every RPC that already calls them -- publish_marketplace_request,
-- submit_marketplace_offer, create_order, create_booking_request,
-- accept_booking_request, propose_barter, accept_barter_offer,
-- create_rent_to_buy_request, accept_rent_to_buy_request, and every
-- barter counter-offer RPC added since -- automatically also blocks an
-- erased account, with zero changes to any of those functions
-- themselves. CREATE OR REPLACE on an already-applied function, per
-- this codebase's established convention for trigger/guard changes.
-- ─────────────────────────────────────────
create or replace function public._assert_account_status_permits_creation(p_user_id uuid, p_relation text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  select account_status::text into v_status from public.profiles where id = p_user_id;
  if v_status in ('restricted', 'suspended', 'erased') then
    raise exception 'account_restricted:%', p_relation;
  end if;
end;
$$;

create or replace function public._assert_account_status_permits_transaction(p_user_id uuid, p_relation text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  select account_status::text into v_status from public.profiles where id = p_user_id;
  if v_status in ('suspended', 'erased') then
    raise exception 'account_suspended:%', p_relation;
  end if;
end;
$$;

-- Reproduced in full from its live body (20260808000001) with exactly
-- one addition: the new "erased accounts can never be restored" guard,
-- inserted at the same point the existing "not found" check already
-- runs. Every other line is unchanged.
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
  if v_previous_status::text = 'erased' then
    raise exception 'an erased account can never be restored';
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
-- account_erasure_log -- admin-only, immutable audit trail. Mirrors
-- user_account_history exactly (20260808000001), except requested_by is
-- the acting principal (the user themself for self-service, an admin
-- for admin-assisted) rather than an admin-only admin_id, since most
-- erasure requests have no admin actor at all. Deliberately does NOT
-- store any of the PII that was just erased -- only the stable
-- user_id reference (safe: the profiles row is never deleted, only
-- anonymized, so this FK is always satisfiable) and bounded category
-- labels.
-- ─────────────────────────────────────────
create table if not exists public.account_erasure_log (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.profiles(id),
  requested_by       uuid not null references public.profiles(id),
  request_source     text not null check (request_source in ('self_service', 'admin')),
  outcome            text not null check (outcome in ('completed', 'blocked')),
  blocked_categories text[] not null default '{}',
  requested_at       timestamptz not null default now(),
  completed_at       timestamptz,
  created_at         timestamptz not null default now()
);

create index if not exists account_erasure_log_user_idx on public.account_erasure_log(user_id, created_at);

alter table public.account_erasure_log enable row level security;

create policy "account_erasure_log: admin read"
  on public.account_erasure_log for select
  using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));

-- No client write policy at all -- only the service-role erase_account()
-- RPC below ever inserts a row.
drop trigger if exists account_erasure_log_immutable_trg on public.account_erasure_log;
create trigger account_erasure_log_immutable_trg
  before update or delete on public.account_erasure_log
  for each row execute procedure public.prevent_row_mutation();

-- ─────────────────────────────────────────
-- erase_account -- the single authoritative erasure/anonymization
-- workflow. SECURITY DEFINER, service-role-gated only -- called from
-- the self-service route (p_actor_id = the user's own id,
-- p_request_source = 'self_service') or the admin-assisted route
-- (p_actor_id = the admin's id, p_request_source = 'admin'). Idempotent
-- by construction: the authoritative state change only ever happens
-- once (guarded by v_already_erased), and calling this again on an
-- already-erased account is a safe, cheap no-op that returns the same
-- shape of result -- deliberately NOT an error, so a retried request
-- (network retry, a second click) never surfaces a confusing failure.
--
-- The active-obligation gate runs BEFORE any mutation, inside the same
-- row-locked transaction, and is fail-closed: any category found blocks
-- the entire erasure, and the attempt (including which categories
-- blocked it) is still durably logged -- this is the record the brief
-- asked for of "why erasure could not complete yet", without ever
-- exposing which specific booking/order/dispute caused it.
--
-- Storage-object deletion (avatars, kyc-documents) and disabling the
-- Supabase Auth identity happen in the calling application code AFTER
-- this RPC returns a completed/already-erased result, never here --
-- this function only ever touches Postgres, matching every other RPC
-- in this codebase, and those two operations cannot participate in a
-- Postgres transaction anyway. Both are naturally idempotent/safe to
-- retry (removing an already-removed object, re-banning an
-- already-banned user are no-ops), so the calling route always attempts
-- them whenever this RPC reports status = 'erased', whether this call
-- newly transitioned the account or found it already erased -- giving
-- natural self-healing if a prior attempt's storage cleanup partially
-- failed.
-- ─────────────────────────────────────────
create or replace function public.erase_account(
  p_user_id uuid,
  p_actor_id uuid,
  p_request_source text,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile record;
  v_already_erased boolean;
  v_blocked text[] := '{}';
  v_request_hash text;
  v_idem record;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_actor_id is null then
    raise exception 'not authenticated';
  end if;
  if p_request_source not in ('self_service', 'admin') then
    raise exception 'invalid request source';
  end if;
  if p_request_source = 'admin' and p_actor_id = p_user_id then
    raise exception 'use the self-service erasure flow for your own account';
  end if;

  v_request_hash := md5(coalesce(p_user_id::text, '') || '|' || coalesce(p_request_source, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_actor_id and operation = 'erase_account' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select id, account_status into v_profile from public.profiles where id = p_user_id for update;
  if v_profile.id is null then
    raise exception 'user not found';
  end if;

  v_already_erased := (v_profile.account_status::text = 'erased');

  if not v_already_erased then
    if exists (
      select 1 from public.bookings
      where (renter_id = p_user_id or merchant_id = p_user_id)
        and status in ('requested', 'accepted', 'active', 'return_pending')
    ) then
      v_blocked := array_append(v_blocked, 'active_booking');
    end if;

    if exists (
      select 1 from public.disputes d
      where d.status in ('open', 'evidence', 'under_review', 'escalated')
        and (
          d.raised_by = p_user_id
          or exists (select 1 from public.bookings b where b.id = d.booking_id and (b.renter_id = p_user_id or b.merchant_id = p_user_id))
          or exists (select 1 from public.orders o where o.id = d.order_id and (o.buyer_id = p_user_id or o.seller_id = p_user_id))
          or exists (select 1 from public.barter_agreements ba where ba.id = d.barter_agreement_id and (ba.party_a_id = p_user_id or ba.party_b_id = p_user_id))
        )
    ) then
      v_blocked := array_append(v_blocked, 'open_dispute');
    end if;

    if exists (
      select 1 from public.orders
      where (buyer_id = p_user_id or seller_id = p_user_id)
        and status in ('pending', 'paid', 'shipped', 'disputed')
    ) then
      v_blocked := array_append(v_blocked, 'unsettled_order');
    end if;

    if exists (
      select 1 from public.rent_to_buy_agreements
      where (merchant_id = p_user_id or customer_id = p_user_id)
        and status in ('pending_merchant_acceptance', 'awaiting_first_payment', 'active', 'defaulted', 'return_required', 'disputed')
    ) then
      v_blocked := array_append(v_blocked, 'active_rent_to_buy');
    end if;

    if exists (
      select 1 from public.barter_agreements
      where (party_a_id = p_user_id or party_b_id = p_user_id)
        and status in ('accepted', 'preparing', 'in_transit', 'awaiting_confirmation', 'disputed')
    ) then
      v_blocked := array_append(v_blocked, 'active_barter');
    end if;

    if exists (
      select 1 from public.merchant_payouts
      where merchant_id = p_user_id and status in ('pending', 'processing', 'failed')
    ) then
      v_blocked := array_append(v_blocked, 'unpaid_merchant_payout');
    end if;

    if exists (
      select 1 from public.refunds r
      join public.payments p on p.id = r.payment_id
      where (p.renter_id = p_user_id or p.merchant_id = p_user_id)
        and r.status in ('pending', 'processing')
    ) then
      v_blocked := array_append(v_blocked, 'pending_refund');
    end if;

    if array_length(v_blocked, 1) > 0 then
      insert into public.account_erasure_log (user_id, requested_by, request_source, outcome, blocked_categories, completed_at)
      values (p_user_id, p_actor_id, p_request_source, 'blocked', v_blocked, null);

      v_result := jsonb_build_object('user_id', p_user_id, 'status', v_profile.account_status, 'blocked', true, 'blocked_categories', v_blocked);

      if p_idempotency_key is not null then
        insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
        values (p_actor_id, 'erase_account', p_idempotency_key, v_request_hash, v_result);
      end if;

      return v_result;
    end if;

    update public.profiles set
      full_name = 'Deleted User',
      display_name = 'Deleted User',
      business_name = null,
      phone = null,
      avatar_url = null,
      account_status = 'erased',
      status_reason = 'account_erased',
      status_changed_at = now(),
      status_changed_by = p_actor_id
    where id = p_user_id;

    update public.identity_verifications set
      legal_first_name = null,
      legal_surname = null,
      date_of_birth = null,
      id_reference_number = null,
      nationality = null,
      country_of_residence = null,
      residential_address = null,
      provider_reference = null
    where user_id = p_user_id;

    update public.email_deliveries set recipient_email = null where recipient_user_id = p_user_id;

    update public.listings set status = 'suspended'
    where merchant_id = p_user_id and status in ('draft', 'pending', 'active', 'paused');

    update public.marketplace_requests set status = 'closed'
    where requester_id = p_user_id and status in ('draft', 'active', 'offers_received');

    update public.barter_skill_task_posts set status = 'closed'
    where owner_id = p_user_id and status in ('draft', 'active', 'offers_received', 'paused');

    insert into public.account_erasure_log (user_id, requested_by, request_source, outcome, blocked_categories, completed_at)
    values (p_user_id, p_actor_id, p_request_source, 'completed', '{}', now());
  end if;

  v_result := jsonb_build_object('user_id', p_user_id, 'status', 'erased', 'blocked', false, 'already_erased', v_already_erased);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_actor_id, 'erase_account', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

revoke all on function public.erase_account(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.erase_account(uuid, uuid, text, text) to service_role;
