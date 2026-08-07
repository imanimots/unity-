-- ============================================================
-- Step 11 Phase 8 -- merchant payout lifecycle RPCs
-- ============================================================
-- Four narrow, trusted operations plus one shared internal transition
-- helper, mirroring the exact shape and safety properties already
-- proven for _affiliate_commission_transition() in Phase 7: locks the
-- row FOR UPDATE, validates the allowed-from-status array, captures
-- previous_status from the initial locking read (never a post-update
-- re-query -- that exact ordering bug was found and fixed in Phase 7),
-- writes one immutable history row, returns the updated row.
--
-- Eligibility differs per transition (approved correction, not a
-- uniform check on all four):
--   - mark_payout_processing (pending -> processing) and retry_payout
--     (failed -> processing) both perform the FULL eligibility check
--     (booking completed, rental payment captured, no unresolved
--     dispute, payment not refunded/chargeback, merchant not
--     suspended/restricted).
--   - mark_payout_paid (processing -> paid) rechecks only that nothing
--     CURRENTLY blocks payment (dispute/refund/chargeback/restriction),
--     plus its own mandatory reference/method/confirmation.
--   - mark_payout_failed (processing -> failed) does NOT gate on
--     positive eligibility at all -- it must remain usable precisely
--     because something has gone wrong, otherwise the exact condition
--     causing the failure would make the transition to failed
--     impossible. It only requires current status = processing, a
--     normalized failure_category, and an admin reason.
--
-- failure_message_safe is derived here, server-side, from a fixed
-- category->sentence mapping -- never the admin's own free-text reason,
-- which is stored only in history (admin-visible, never merchant-facing).
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

create or replace function public._merchant_payout_transition(
  p_payout_id uuid,
  p_new_status payout_status,
  p_allowed_from payout_status[],
  p_actor_type text,
  p_actor_id uuid,
  p_action text,
  p_reason text default null,
  p_failure_category text default null,
  p_failure_message_safe text default null,
  p_payout_reference text default null,
  p_payout_method text default null,
  p_increment_attempt boolean default false,
  p_idempotency_key text default null
)
returns public.merchant_payouts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payout public.merchant_payouts;
  v_previous_status public.payout_status;
begin
  select * into v_payout from public.merchant_payouts where id = p_payout_id for update;
  if v_payout.id is null then
    raise exception 'payout not found';
  end if;
  if not (v_payout.status = any(p_allowed_from)) then
    raise exception 'payout is in status % and cannot transition to % from here', v_payout.status, p_new_status;
  end if;
  v_previous_status := v_payout.status;

  update public.merchant_payouts
  set status = p_new_status,
      processing_started_at = case when p_new_status = 'processing' then now() else processing_started_at end,
      processing_started_by = case when p_new_status = 'processing' then p_actor_id else processing_started_by end,
      paid_at = case when p_new_status = 'paid' then now() else paid_at end,
      paid_by = case when p_new_status = 'paid' then p_actor_id else paid_by end,
      failed_at = case when p_new_status = 'failed' then now() else failed_at end,
      failed_by = case when p_new_status = 'failed' then p_actor_id else failed_by end,
      failure_category = case when p_new_status = 'failed' then p_failure_category else failure_category end,
      failure_message_safe = case when p_new_status = 'failed' then p_failure_message_safe else failure_message_safe end,
      provider_reference = case when p_new_status = 'paid' then coalesce(p_payout_reference, provider_reference) else provider_reference end,
      payout_method = case when p_new_status = 'paid' then coalesce(p_payout_method, payout_method) else payout_method end,
      attempt_count = case when p_increment_attempt then attempt_count + 1 else attempt_count end,
      last_attempt_at = case when p_increment_attempt then now() else last_attempt_at end
  where id = p_payout_id
  returning * into v_payout;

  insert into public.merchant_payout_history (
    payout_id, booking_id, merchant_id, previous_status, new_status,
    actor_type, actor_id, action, reason, failure_category, payout_reference, idempotency_key
  ) values (
    v_payout.id, v_payout.booking_id, v_payout.merchant_id, v_previous_status::text, p_new_status::text,
    p_actor_type, p_actor_id, p_action, p_reason, p_failure_category, p_payout_reference, p_idempotency_key
  );

  return v_payout;
end;
$$;

-- ------------------------------------------------------------
-- Shared full-eligibility check, used by mark_payout_processing and
-- retry_payout. Returns null when eligible, or a short blocking-reason
-- code when not -- callers raise a descriptive exception using it.
-- ------------------------------------------------------------
create or replace function public._merchant_payout_full_eligibility_block(p_payout public.merchant_payouts)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking record;
  v_rental_payment record;
begin
  if p_payout.booking_id is null then
    return 'source_payment_issue';
  end if;

  select id, status, merchant_id into v_booking from public.bookings where id = p_payout.booking_id;
  if v_booking.id is null or v_booking.status <> 'completed' then
    return 'source_payment_issue';
  end if;

  select id, status into v_rental_payment
  from public.payments
  where booking_id = p_payout.booking_id and payment_type = 'rental_charge';
  if v_rental_payment.id is null or v_rental_payment.status <> 'captured' then
    return 'source_payment_issue';
  end if;

  if exists (
    select 1 from public.disputes
    where booking_id = p_payout.booking_id and status not in ('resolved', 'closed', 'cancelled')
  ) then
    return 'compliance_review';
  end if;

  if exists (
    select 1 from public.profiles where id = p_payout.merchant_id and account_status in ('suspended', 'restricted')
  ) then
    return 'account_restricted';
  end if;

  return null;
end;
$$;

-- ------------------------------------------------------------
-- Subset check used only by mark_payout_paid -- does not re-verify
-- booking completion or original capture (those don't change once a
-- payout has already reached 'processing'); only checks for a NEW
-- blocking condition that may have appeared since.
-- ------------------------------------------------------------
create or replace function public._merchant_payout_still_safe_to_pay_block(p_payout public.merchant_payouts)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rental_payment_status payment_status;
begin
  if exists (
    select 1 from public.disputes
    where booking_id = p_payout.booking_id and status not in ('resolved', 'closed', 'cancelled')
  ) then
    return 'compliance_review';
  end if;

  if exists (
    select 1 from public.profiles where id = p_payout.merchant_id and account_status in ('suspended', 'restricted')
  ) then
    return 'account_restricted';
  end if;

  select status into v_rental_payment_status
  from public.payments
  where booking_id = p_payout.booking_id and payment_type = 'rental_charge';
  if v_rental_payment_status in ('refunded', 'partially_refunded', 'chargeback') then
    return 'source_payment_issue';
  end if;

  return null;
end;
$$;

-- ------------------------------------------------------------
-- MARK PAYOUT PROCESSING -- pending -> processing.
-- ------------------------------------------------------------
create or replace function public.mark_payout_processing(
  p_admin_id uuid,
  p_payout_id uuid,
  p_reason text default null,
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
  v_payout public.merchant_payouts;
  v_block text;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_admin_id is null then
    raise exception 'not authenticated';
  end if;

  v_request_hash := md5(coalesce(p_payout_id::text, '') || '|' || coalesce(p_reason, ''));
  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_admin_id and operation = 'mark_payout_processing' and idempotency_key = p_idempotency_key;
    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select * into v_payout from public.merchant_payouts where id = p_payout_id;
  if v_payout.id is null then
    raise exception 'payout not found';
  end if;
  if v_payout.status <> 'pending' then
    raise exception 'payout is in status % and cannot start processing from here', v_payout.status;
  end if;

  v_block := public._merchant_payout_full_eligibility_block(v_payout);
  if v_block is not null then
    raise exception 'payout is not currently eligible to process: %', v_block;
  end if;

  v_payout := public._merchant_payout_transition(
    p_payout_id, 'processing', array['pending']::payout_status[],
    'admin', p_admin_id, 'mark_processing', p_reason,
    null, null, null, null, true, p_idempotency_key
  );

  v_result := jsonb_build_object('payout_id', v_payout.id, 'status', v_payout.status, 'attempt_count', v_payout.attempt_count);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_admin_id, 'mark_payout_processing', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

-- ------------------------------------------------------------
-- RETRY PAYOUT -- failed -> processing. Same row, never a new one.
-- ------------------------------------------------------------
create or replace function public.retry_payout(
  p_admin_id uuid,
  p_payout_id uuid,
  p_reason text,
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
  v_payout public.merchant_payouts;
  v_block text;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_admin_id is null then
    raise exception 'not authenticated';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a reason is required to retry a payout';
  end if;

  v_request_hash := md5(coalesce(p_payout_id::text, '') || '|' || coalesce(p_reason, ''));
  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_admin_id and operation = 'retry_payout' and idempotency_key = p_idempotency_key;
    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select * into v_payout from public.merchant_payouts where id = p_payout_id;
  if v_payout.id is null then
    raise exception 'payout not found';
  end if;
  if v_payout.status <> 'failed' then
    raise exception 'payout is in status % and cannot be retried from here', v_payout.status;
  end if;

  v_block := public._merchant_payout_full_eligibility_block(v_payout);
  if v_block is not null then
    raise exception 'payout is not currently eligible to retry: %', v_block;
  end if;

  v_payout := public._merchant_payout_transition(
    p_payout_id, 'processing', array['failed']::payout_status[],
    'admin', p_admin_id, 'retry', p_reason,
    null, null, null, null, true, p_idempotency_key
  );

  v_result := jsonb_build_object('payout_id', v_payout.id, 'status', v_payout.status, 'attempt_count', v_payout.attempt_count);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_admin_id, 'retry_payout', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

-- ------------------------------------------------------------
-- MARK PAYOUT PAID -- processing -> paid. Manual/mock_validation only.
-- ------------------------------------------------------------
create or replace function public.mark_payout_paid(
  p_admin_id uuid,
  p_payout_id uuid,
  p_payout_reference text,
  p_payout_method text,
  p_confirm_manual_payment boolean,
  p_reason text default null,
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
  v_payout public.merchant_payouts;
  v_block text;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_admin_id is null then
    raise exception 'not authenticated';
  end if;
  if p_confirm_manual_payment is distinct from true then
    raise exception 'manual payment confirmation is required';
  end if;
  if p_payout_reference is null or length(trim(p_payout_reference)) = 0 then
    raise exception 'a payout reference is required';
  end if;
  if p_payout_method is null or p_payout_method not in ('manual', 'mock_validation') then
    raise exception 'invalid payout method';
  end if;

  v_request_hash := md5(coalesce(p_payout_id::text, '') || '|' || coalesce(p_payout_reference, '') || '|' || coalesce(p_payout_method, ''));
  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_admin_id and operation = 'mark_payout_paid' and idempotency_key = p_idempotency_key;
    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select * into v_payout from public.merchant_payouts where id = p_payout_id;
  if v_payout.id is null then
    raise exception 'payout not found';
  end if;
  if v_payout.status <> 'processing' then
    raise exception 'payout is in status % and cannot be marked paid from here', v_payout.status;
  end if;

  v_block := public._merchant_payout_still_safe_to_pay_block(v_payout);
  if v_block is not null then
    raise exception 'payout can no longer be safely marked paid: %', v_block;
  end if;

  v_payout := public._merchant_payout_transition(
    p_payout_id, 'paid', array['processing']::payout_status[],
    'admin', p_admin_id, 'mark_paid', p_reason,
    null, null, p_payout_reference, p_payout_method, false, p_idempotency_key
  );

  v_result := jsonb_build_object('payout_id', v_payout.id, 'status', v_payout.status, 'paid_at', v_payout.paid_at, 'payout_reference', v_payout.provider_reference);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_admin_id, 'mark_payout_paid', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

-- ------------------------------------------------------------
-- MARK PAYOUT FAILED -- processing -> failed. No positive-eligibility
-- gate (Correction 3) -- must remain usable precisely when eligibility
-- has broken down. failure_message_safe is derived here, server-side,
-- from a fixed category mapping -- never the admin's own free text.
-- ------------------------------------------------------------
create or replace function public.mark_payout_failed(
  p_admin_id uuid,
  p_payout_id uuid,
  p_failure_category text,
  p_reason text,
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
  v_payout public.merchant_payouts;
  v_safe_message text;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_admin_id is null then
    raise exception 'not authenticated';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a reason is required to mark a payout failed';
  end if;
  if p_failure_category not in (
    'recipient_details_unavailable', 'recipient_details_invalid', 'provider_unavailable',
    'provider_declined', 'compliance_review', 'account_restricted',
    'source_payment_issue', 'internal_consistency_error', 'other'
  ) then
    raise exception 'invalid failure category';
  end if;

  v_request_hash := md5(coalesce(p_payout_id::text, '') || '|' || coalesce(p_failure_category, '') || '|' || coalesce(p_reason, ''));
  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_admin_id and operation = 'mark_payout_failed' and idempotency_key = p_idempotency_key;
    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select * into v_payout from public.merchant_payouts where id = p_payout_id;
  if v_payout.id is null then
    raise exception 'payout not found';
  end if;
  if v_payout.status <> 'processing' then
    raise exception 'payout is in status % and cannot be marked failed from here', v_payout.status;
  end if;

  v_safe_message := case p_failure_category
    when 'recipient_details_unavailable' then 'Unity does not yet have the information required to complete this payout.'
    when 'recipient_details_invalid' then 'The payout details on file could not be used. Unity will review and update them.'
    when 'provider_unavailable' then 'Payout processing is temporarily unavailable.'
    when 'provider_declined' then 'This payout could not be completed and is being reviewed.'
    when 'compliance_review' then 'This payout is under compliance review before it can continue.'
    when 'account_restricted' then 'This payout requires account review before it can continue.'
    when 'source_payment_issue' then 'The source rental payment requires review before payout can continue.'
    when 'internal_consistency_error' then 'Unity is reviewing an internal payout issue.'
    else 'This payout could not be completed. Unity will review it.'
  end;

  v_payout := public._merchant_payout_transition(
    p_payout_id, 'failed', array['processing']::payout_status[],
    'admin', p_admin_id, 'mark_failed', p_reason,
    p_failure_category, v_safe_message, null, null, false, p_idempotency_key
  );

  v_result := jsonb_build_object('payout_id', v_payout.id, 'status', v_payout.status, 'failure_category', v_payout.failure_category, 'failure_message_safe', v_payout.failure_message_safe);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_admin_id, 'mark_payout_failed', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

revoke all on function public._merchant_payout_transition(uuid, payout_status, payout_status[], text, uuid, text, text, text, text, text, text, boolean, text) from public, anon, authenticated;
grant execute on function public._merchant_payout_transition(uuid, payout_status, payout_status[], text, uuid, text, text, text, text, text, text, boolean, text) to service_role;

revoke all on function public._merchant_payout_full_eligibility_block(public.merchant_payouts) from public, anon, authenticated;
grant execute on function public._merchant_payout_full_eligibility_block(public.merchant_payouts) to service_role;

revoke all on function public._merchant_payout_still_safe_to_pay_block(public.merchant_payouts) from public, anon, authenticated;
grant execute on function public._merchant_payout_still_safe_to_pay_block(public.merchant_payouts) to service_role;

revoke all on function public.mark_payout_processing(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.mark_payout_processing(uuid, uuid, text, text) to service_role;

revoke all on function public.retry_payout(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.retry_payout(uuid, uuid, text, text) to service_role;

revoke all on function public.mark_payout_paid(uuid, uuid, text, text, boolean, text, text) from public, anon, authenticated;
grant execute on function public.mark_payout_paid(uuid, uuid, text, text, boolean, text, text) to service_role;

revoke all on function public.mark_payout_failed(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.mark_payout_failed(uuid, uuid, text, text, text) to service_role;
