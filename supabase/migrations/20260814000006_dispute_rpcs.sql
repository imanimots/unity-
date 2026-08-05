-- ============================================================
-- Step 11 Phase 2 -- generic dispute RPCs
-- ============================================================
-- One dispute workflow reused identically by bookings, orders, and
-- barter -- every RPC here takes p_booking_id/p_order_id/
-- p_barter_agreement_id as alternatives at open time, then operates
-- purely on the disputes row afterward (no domain-specific branching
-- needed for assign/review/request-evidence/resolve/close/cancel,
-- since disputes itself is already the generic resource).
--
-- Every RPC: SECURITY DEFINER, service_role-only (auth.role() check),
-- idempotency-keyed via the same idempotency_keys table every other
-- domain uses (merchant_id column reused generically as "the acting
-- user id", same precedent as bookings/barter/orders).
--
-- open_dispute() sets the referenced booking/order/barter_agreement's
-- own status to 'disputed' -- a value all three enums already have.
-- This is NOT undone by resolve_dispute/close_dispute/cancel_dispute in
-- this phase (see docs/DISPUTE_SYSTEM.md "Known limitations") --
-- deciding what a transaction should become after a resolved dispute
-- depends on financial-outcome execution that's out of scope here.
-- Verified live (Step 0) that cancel_barter_agreement already
-- explicitly rejects status='disputed', and cancel_booking/
-- mark_order_shipped use exact-match status guards that will reject it
-- too -- so this freezes other transitions without touching those
-- existing RPCs.
--
-- resolve_dispute/close_dispute/cancel_dispute are admin-only per the
-- brief's Part H. Like every existing admin RPC in this codebase
-- (e.g. decide_moderation), p_admin_id is trusted once passed in --
-- the real boundary is the Next.js route's requireAdminForRoute() gate,
-- which is the only way to reach this service_role-only function at
-- all. No redundant profiles.role check inside the RPC, matching that
-- established convention exactly.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

-- ─────────────────────────────────────────
-- open_dispute
-- ─────────────────────────────────────────
create or replace function public.open_dispute(
  p_raiser_user_id uuid,
  p_booking_id uuid default null,
  p_order_id uuid default null,
  p_barter_agreement_id uuid default null,
  p_title text default null,
  p_reason text default null,
  p_description text default null,
  p_requested_resolution text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dispute_id uuid;
  v_reference_count int;
  v_request_hash text;
  v_idem record;
  v_result jsonb;
  v_booking record;
  v_order record;
  v_agreement record;
  v_respondent_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_raiser_user_id is null then
    raise exception 'raiser is required';
  end if;
  if p_title is null or length(trim(p_title)) = 0 then
    raise exception 'title is required';
  end if;
  if p_description is null or length(trim(p_description)) = 0 then
    raise exception 'description is required';
  end if;
  if p_requested_resolution is null or length(trim(p_requested_resolution)) = 0 then
    raise exception 'requested resolution is required';
  end if;

  v_reference_count := (case when p_booking_id is not null then 1 else 0 end)
    + (case when p_order_id is not null then 1 else 0 end)
    + (case when p_barter_agreement_id is not null then 1 else 0 end);
  if v_reference_count <> 1 then
    raise exception 'exactly one of booking_id, order_id, or barter_agreement_id is required';
  end if;

  v_request_hash := md5(
    coalesce(p_booking_id::text, '') || '|' || coalesce(p_order_id::text, '') || '|' || coalesce(p_barter_agreement_id::text, '') || '|' ||
    coalesce(p_title, '') || '|' || coalesce(p_reason, '') || '|' || coalesce(p_description, '') || '|' || coalesce(p_requested_resolution, '')
  );

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_raiser_user_id and operation = 'open_dispute' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  if p_booking_id is not null then
    select id, renter_id, merchant_id into v_booking from public.bookings where id = p_booking_id for update;
    if v_booking.id is null then
      raise exception 'booking not found';
    end if;
    if v_booking.renter_id <> p_raiser_user_id and v_booking.merchant_id <> p_raiser_user_id then
      raise exception 'raiser is not a party to this booking';
    end if;
    v_respondent_id := case when v_booking.renter_id = p_raiser_user_id then v_booking.merchant_id else v_booking.renter_id end;
    if exists (select 1 from public.disputes where booking_id = p_booking_id and status not in ('resolved', 'closed', 'cancelled')) then
      raise exception 'a dispute is already open for this booking';
    end if;
    update public.bookings set status = 'disputed' where id = p_booking_id;
  elsif p_order_id is not null then
    select id, buyer_id, seller_id into v_order from public.orders where id = p_order_id for update;
    if v_order.id is null then
      raise exception 'order not found';
    end if;
    if v_order.buyer_id <> p_raiser_user_id and v_order.seller_id <> p_raiser_user_id then
      raise exception 'raiser is not a party to this order';
    end if;
    v_respondent_id := case when v_order.buyer_id = p_raiser_user_id then v_order.seller_id else v_order.buyer_id end;
    if exists (select 1 from public.disputes where order_id = p_order_id and status not in ('resolved', 'closed', 'cancelled')) then
      raise exception 'a dispute is already open for this order';
    end if;
    update public.orders set status = 'disputed' where id = p_order_id;
  else
    select id, party_a_id, party_b_id into v_agreement from public.barter_agreements where id = p_barter_agreement_id for update;
    if v_agreement.id is null then
      raise exception 'barter agreement not found';
    end if;
    if v_agreement.party_a_id <> p_raiser_user_id and v_agreement.party_b_id <> p_raiser_user_id then
      raise exception 'raiser is not a party to this barter agreement';
    end if;
    v_respondent_id := case when v_agreement.party_a_id = p_raiser_user_id then v_agreement.party_b_id else v_agreement.party_a_id end;
    if exists (select 1 from public.disputes where barter_agreement_id = p_barter_agreement_id and status not in ('resolved', 'closed', 'cancelled')) then
      raise exception 'a dispute is already open for this barter agreement';
    end if;
    update public.barter_agreements set status = 'disputed' where id = p_barter_agreement_id;
  end if;

  insert into public.disputes (
    booking_id, order_id, barter_agreement_id, raised_by, title, reason, description, requested_resolution, status
  ) values (
    p_booking_id, p_order_id, p_barter_agreement_id, p_raiser_user_id, p_title, p_reason, p_description, p_requested_resolution, 'open'
  )
  returning id into v_dispute_id;

  insert into public.dispute_history (dispute_id, actor_user_id, actor_role, event_type, previous_status, new_status, idempotency_key)
  values (v_dispute_id, p_raiser_user_id, 'raiser', 'dispute_opened', null, 'open', p_idempotency_key);

  v_result := jsonb_build_object('dispute_id', v_dispute_id, 'status', 'open', 'respondent_id', v_respondent_id);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_raiser_user_id, 'open_dispute', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

revoke all on function public.open_dispute(uuid, uuid, uuid, uuid, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.open_dispute(uuid, uuid, uuid, uuid, text, text, text, text, text) to service_role;

-- ─────────────────────────────────────────
-- assign_dispute_to_admin
-- ─────────────────────────────────────────
create or replace function public.assign_dispute_to_admin(
  p_admin_id uuid,
  p_dispute_id uuid,
  p_assignee_admin_id uuid,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dispute record;
  v_request_hash text;
  v_idem record;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_admin_id is null then
    raise exception 'admin is required';
  end if;
  if not exists (select 1 from public.profiles where id = p_assignee_admin_id and role = 'admin') then
    raise exception 'assignee must be an admin';
  end if;

  v_request_hash := md5(coalesce(p_dispute_id::text, '') || '|' || coalesce(p_assignee_admin_id::text, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_admin_id and operation = 'assign_dispute_to_admin' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select id, status into v_dispute from public.disputes where id = p_dispute_id for update;
  if v_dispute.id is null then
    raise exception 'dispute not found';
  end if;
  if v_dispute.status in ('resolved', 'closed', 'cancelled') then
    raise exception 'this dispute is no longer active';
  end if;

  update public.disputes set assigned_admin_id = p_assignee_admin_id where id = p_dispute_id;

  insert into public.dispute_history (dispute_id, actor_user_id, actor_role, event_type, previous_status, new_status, metadata, idempotency_key)
  values (p_dispute_id, p_admin_id, 'admin', 'dispute_assigned', v_dispute.status::text, v_dispute.status::text, jsonb_build_object('assignee_admin_id', p_assignee_admin_id), p_idempotency_key);

  v_result := jsonb_build_object('dispute_id', p_dispute_id, 'status', v_dispute.status, 'assigned_admin_id', p_assignee_admin_id);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_admin_id, 'assign_dispute_to_admin', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

revoke all on function public.assign_dispute_to_admin(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.assign_dispute_to_admin(uuid, uuid, uuid, text) to service_role;

-- ─────────────────────────────────────────
-- start_dispute_review
-- ─────────────────────────────────────────
create or replace function public.start_dispute_review(
  p_admin_id uuid,
  p_dispute_id uuid,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dispute record;
  v_request_hash text;
  v_idem record;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_admin_id is null then
    raise exception 'admin is required';
  end if;

  v_request_hash := md5(coalesce(p_dispute_id::text, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_admin_id and operation = 'start_dispute_review' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select id, status into v_dispute from public.disputes where id = p_dispute_id for update;
  if v_dispute.id is null then
    raise exception 'dispute not found';
  end if;
  if v_dispute.status not in ('open', 'evidence') then
    raise exception 'this dispute is not ready to move into review';
  end if;

  update public.disputes set status = 'under_review' where id = p_dispute_id;

  insert into public.dispute_history (dispute_id, actor_user_id, actor_role, event_type, previous_status, new_status, idempotency_key)
  values (p_dispute_id, p_admin_id, 'admin', 'dispute_review_started', v_dispute.status::text, 'under_review', p_idempotency_key);

  v_result := jsonb_build_object('dispute_id', p_dispute_id, 'status', 'under_review');

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_admin_id, 'start_dispute_review', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

revoke all on function public.start_dispute_review(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.start_dispute_review(uuid, uuid, text) to service_role;

-- ─────────────────────────────────────────
-- request_dispute_evidence
-- ─────────────────────────────────────────
create or replace function public.request_dispute_evidence(
  p_admin_id uuid,
  p_dispute_id uuid,
  p_note text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dispute record;
  v_request_hash text;
  v_idem record;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_admin_id is null then
    raise exception 'admin is required';
  end if;

  v_request_hash := md5(coalesce(p_dispute_id::text, '') || '|' || coalesce(p_note, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_admin_id and operation = 'request_dispute_evidence' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select id, status into v_dispute from public.disputes where id = p_dispute_id for update;
  if v_dispute.id is null then
    raise exception 'dispute not found';
  end if;
  if v_dispute.status not in ('open', 'under_review') then
    raise exception 'evidence can only be requested while a dispute is open or under review';
  end if;

  update public.disputes set
    status = 'evidence',
    evidence_requested_by = p_admin_id,
    evidence_requested_at = now(),
    evidence_request_note = p_note
  where id = p_dispute_id;

  insert into public.dispute_history (dispute_id, actor_user_id, actor_role, event_type, previous_status, new_status, metadata, idempotency_key)
  values (p_dispute_id, p_admin_id, 'admin', 'dispute_evidence_requested', v_dispute.status::text, 'evidence', jsonb_build_object('note', p_note), p_idempotency_key);

  v_result := jsonb_build_object('dispute_id', p_dispute_id, 'status', 'evidence');

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_admin_id, 'request_dispute_evidence', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

revoke all on function public.request_dispute_evidence(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.request_dispute_evidence(uuid, uuid, text, text) to service_role;

-- ─────────────────────────────────────────
-- resolve_dispute
-- ─────────────────────────────────────────
create or replace function public.resolve_dispute(
  p_admin_id uuid,
  p_dispute_id uuid,
  p_outcome text,
  p_resolution_notes text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dispute record;
  v_request_hash text;
  v_idem record;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_admin_id is null then
    raise exception 'admin is required';
  end if;
  if p_outcome not in ('favor_raiser', 'favor_respondent', 'mutual_agreement', 'manual_settlement') then
    raise exception 'invalid outcome';
  end if;

  v_request_hash := md5(coalesce(p_dispute_id::text, '') || '|' || coalesce(p_outcome, '') || '|' || coalesce(p_resolution_notes, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_admin_id and operation = 'resolve_dispute' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select id, status into v_dispute from public.disputes where id = p_dispute_id for update;
  if v_dispute.id is null then
    raise exception 'dispute not found';
  end if;
  if v_dispute.status <> 'under_review' then
    raise exception 'a dispute can only be resolved while under review';
  end if;

  update public.disputes set
    status = 'resolved',
    outcome = p_outcome,
    resolution_notes = p_resolution_notes,
    resolved_by = p_admin_id,
    resolved_at = now()
  where id = p_dispute_id;

  insert into public.dispute_history (dispute_id, actor_user_id, actor_role, event_type, previous_status, new_status, metadata, idempotency_key)
  values (p_dispute_id, p_admin_id, 'admin', 'dispute_resolved', 'under_review', 'resolved', jsonb_build_object('outcome', p_outcome), p_idempotency_key);

  v_result := jsonb_build_object('dispute_id', p_dispute_id, 'status', 'resolved', 'outcome', p_outcome);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_admin_id, 'resolve_dispute', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

revoke all on function public.resolve_dispute(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.resolve_dispute(uuid, uuid, text, text, text) to service_role;

-- ─────────────────────────────────────────
-- close_dispute
-- ─────────────────────────────────────────
create or replace function public.close_dispute(
  p_admin_id uuid,
  p_dispute_id uuid,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dispute record;
  v_request_hash text;
  v_idem record;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_admin_id is null then
    raise exception 'admin is required';
  end if;

  v_request_hash := md5(coalesce(p_dispute_id::text, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_admin_id and operation = 'close_dispute' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select id, status into v_dispute from public.disputes where id = p_dispute_id for update;
  if v_dispute.id is null then
    raise exception 'dispute not found';
  end if;
  if v_dispute.status <> 'resolved' then
    raise exception 'a dispute can only be closed after it has been resolved';
  end if;

  update public.disputes set status = 'closed', closed_by = p_admin_id, closed_at = now() where id = p_dispute_id;

  insert into public.dispute_history (dispute_id, actor_user_id, actor_role, event_type, previous_status, new_status, idempotency_key)
  values (p_dispute_id, p_admin_id, 'admin', 'dispute_closed', 'resolved', 'closed', p_idempotency_key);

  v_result := jsonb_build_object('dispute_id', p_dispute_id, 'status', 'closed');

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_admin_id, 'close_dispute', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

revoke all on function public.close_dispute(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.close_dispute(uuid, uuid, text) to service_role;

-- ─────────────────────────────────────────
-- cancel_dispute
-- ─────────────────────────────────────────
create or replace function public.cancel_dispute(
  p_admin_id uuid,
  p_dispute_id uuid,
  p_cancellation_reason text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dispute record;
  v_request_hash text;
  v_idem record;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_admin_id is null then
    raise exception 'admin is required';
  end if;

  v_request_hash := md5(coalesce(p_dispute_id::text, '') || '|' || coalesce(p_cancellation_reason, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_admin_id and operation = 'cancel_dispute' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select id, status into v_dispute from public.disputes where id = p_dispute_id for update;
  if v_dispute.id is null then
    raise exception 'dispute not found';
  end if;
  if v_dispute.status in ('resolved', 'closed', 'cancelled') then
    raise exception 'this dispute is no longer active';
  end if;

  update public.disputes set
    status = 'cancelled',
    cancelled_by = p_admin_id,
    cancelled_at = now(),
    cancellation_reason = p_cancellation_reason
  where id = p_dispute_id;

  insert into public.dispute_history (dispute_id, actor_user_id, actor_role, event_type, previous_status, new_status, metadata, idempotency_key)
  values (p_dispute_id, p_admin_id, 'admin', 'dispute_cancelled', v_dispute.status::text, 'cancelled', jsonb_build_object('reason', p_cancellation_reason), p_idempotency_key);

  v_result := jsonb_build_object('dispute_id', p_dispute_id, 'status', 'cancelled');

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_admin_id, 'cancel_dispute', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

revoke all on function public.cancel_dispute(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.cancel_dispute(uuid, uuid, text, text) to service_role;
