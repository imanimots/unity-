-- ============================================================
-- Booking lifecycle RPCs (Phase 2B)
-- ============================================================
-- All functions below are restricted to service_role EXECUTE only (grants
-- at the end of this file), matching submit_listing_for_review
-- (20260730000002_restrict_submit_to_server.sql). Renter/merchant
-- identity is always passed as an explicit parameter derived by the
-- calling Next.js route from its own verified session -- never taken from
-- auth.uid() (a service-role session has no user JWT) and never trusted
-- from client input beyond that server-side verification.
--
-- Idempotency reuses the existing idempotency_keys table
-- (20260729000008_listing_wizard_closure.sql) exactly as-is. Its primary
-- key column is named merchant_id but is used here as a generic acting-
-- user id for both renter- and merchant-initiated operations -- kept
-- as-is rather than renamed, to avoid touching already-verified Phase 2A
-- RPCs that reference it. See docs/BOOKING_LIFECYCLE.md.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

alter table public.bookings
  add column if not exists return_initiated_by uuid references public.profiles(id);

-- ------------------------------------------------------------
-- CREATE_BOOKING_REQUEST
-- ------------------------------------------------------------
create or replace function public.create_booking_request(
  p_renter_id uuid,
  p_listing_id uuid,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_renter_message text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_listing record;
  v_requirements record;
  v_request_hash text;
  v_idem record;
  v_duration_days numeric(10,2);
  v_deposit numeric(12,2);
  v_subtotal numeric(12,2);
  v_terms jsonb;
  v_booking_id uuid;
  v_reference text;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_renter_id is null then
    raise exception 'not authenticated';
  end if;

  v_request_hash := md5(
    coalesce(p_listing_id::text, '') || '|' ||
    coalesce(extract(epoch from p_start_at)::text, '') || '|' ||
    coalesce(extract(epoch from p_end_at)::text, '') || '|' ||
    coalesce(p_renter_message, '')
  );

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_renter_id and operation = 'create_booking_request' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  if p_start_at is null or p_end_at is null or p_start_at >= p_end_at then
    raise exception 'end time must be after start time';
  end if;
  if p_start_at < now() then
    raise exception 'start time must be in the future';
  end if;

  select id, merchant_id, status, listing_type, daily_rate, deposit_required, deposit_amount,
         min_rental_days, max_rental_days, min_booking_notice_days, max_advance_booking_days,
         shipping_payer
  into v_listing
  from public.listings
  where id = p_listing_id;

  if v_listing.id is null or v_listing.status <> 'active' or v_listing.listing_type <> 'rental' then
    raise exception 'listing not found or not available for booking';
  end if;
  if v_listing.merchant_id = p_renter_id then
    raise exception 'you cannot book your own listing';
  end if;

  v_duration_days := ceil(extract(epoch from (p_end_at - p_start_at)) / 86400.0);

  if v_duration_days < v_listing.min_rental_days then
    raise exception 'requested duration is below the minimum rental period of % days', v_listing.min_rental_days;
  end if;
  if v_listing.max_rental_days is not null and v_duration_days > v_listing.max_rental_days then
    raise exception 'requested duration exceeds the maximum rental period of % days', v_listing.max_rental_days;
  end if;
  if v_listing.min_booking_notice_days is not null
     and p_start_at < now() + make_interval(days => v_listing.min_booking_notice_days) then
    raise exception 'this listing requires at least % days of advance notice', v_listing.min_booking_notice_days;
  end if;
  if v_listing.max_advance_booking_days is not null
     and p_start_at > now() + make_interval(days => v_listing.max_advance_booking_days) then
    raise exception 'this listing cannot be booked more than % days in advance', v_listing.max_advance_booking_days;
  end if;

  if exists (
    select 1 from public.listing_availability
    where listing_id = p_listing_id
      and start_date < p_end_at::date
      and end_date > p_start_at::date
  ) then
    raise exception 'requested dates fall within a period the merchant has marked unavailable';
  end if;

  if exists (
    select 1 from public.bookings
    where listing_id = p_listing_id
      and status in ('accepted', 'active')
      and tstzrange(start_at, end_at, '[)') && tstzrange(p_start_at, p_end_at, '[)')
  ) then
    raise exception 'requested dates are no longer available for this listing';
  end if;

  v_deposit := case when v_listing.deposit_required then coalesce(v_listing.deposit_amount, 0) else 0 end;
  v_subtotal := v_listing.daily_rate * v_duration_days;

  select deposit_basis, requested_deposit_amount, verified_identity_required, kyc_approved_required,
         min_age, driving_licence_required, licence_class, permitted_use, prohibited_use,
         geographic_restriction, merchant_cancellation_notice_hours, renter_cancellation_notice_hours,
         auto_approval_enabled, cancellation_reason_required, existing_damage_description,
         merchant_provides_insurance, renter_insurance_required, excess_amount,
         inspection_required_before_handover, inspection_required_on_return,
         cleaning_requirements, return_condition_requirements, merchant_custom_rules
  into v_requirements
  from public.listing_requirements
  where listing_id = p_listing_id;

  v_terms := jsonb_build_object(
    'min_rental_days', v_listing.min_rental_days,
    'max_rental_days', v_listing.max_rental_days,
    'shipping_payer', v_listing.shipping_payer,
    'deposit_required', v_listing.deposit_required,
    'merchant_cancellation_notice_hours', v_requirements.merchant_cancellation_notice_hours,
    'renter_cancellation_notice_hours', v_requirements.renter_cancellation_notice_hours,
    'verified_identity_required', coalesce(v_requirements.verified_identity_required, false),
    'kyc_approved_required', coalesce(v_requirements.kyc_approved_required, false),
    'min_age', v_requirements.min_age,
    'driving_licence_required', coalesce(v_requirements.driving_licence_required, false),
    'licence_class', v_requirements.licence_class,
    'permitted_use', v_requirements.permitted_use,
    'prohibited_use', v_requirements.prohibited_use,
    'geographic_restriction', v_requirements.geographic_restriction,
    'existing_damage_description', v_requirements.existing_damage_description,
    'merchant_provides_insurance', coalesce(v_requirements.merchant_provides_insurance, false),
    'renter_insurance_required', coalesce(v_requirements.renter_insurance_required, false),
    'excess_amount', v_requirements.excess_amount,
    'inspection_required_before_handover', coalesce(v_requirements.inspection_required_before_handover, false),
    'inspection_required_on_return', coalesce(v_requirements.inspection_required_on_return, false),
    'cleaning_requirements', v_requirements.cleaning_requirements,
    'return_condition_requirements', v_requirements.return_condition_requirements,
    'merchant_custom_rules', v_requirements.merchant_custom_rules
  );

  v_reference := public.generate_booking_reference();

  insert into public.bookings (
    listing_id, renter_id, merchant_id, status, start_at, end_at,
    booking_reference, renter_message, expires_at,
    currency, rate_amount, rate_unit, duration_units, subtotal_amount,
    deposit_amount_snapshot, platform_fee_amount, renter_total_amount, merchant_proceeds_estimate,
    price_calculation_version, terms_snapshot, terms_snapshot_version
  ) values (
    p_listing_id, p_renter_id, v_listing.merchant_id, 'requested', p_start_at, p_end_at,
    v_reference, p_renter_message, now() + interval '48 hours',
    'ZAR', v_listing.daily_rate, 'daily', v_duration_days, v_subtotal,
    v_deposit, 0, v_subtotal + v_deposit, v_subtotal,
    'v1', v_terms, 'v1'
  )
  returning id into v_booking_id;

  insert into public.booking_history (booking_id, actor_user_id, actor_role, event_type, new_status, metadata, idempotency_key)
  values (v_booking_id, p_renter_id, 'renter', 'booking_requested', 'requested', jsonb_build_object('start_at', p_start_at, 'end_at', p_end_at), p_idempotency_key);

  v_result := jsonb_build_object('booking_id', v_booking_id, 'booking_reference', v_reference, 'status', 'requested');

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_renter_id, 'create_booking_request', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

-- ------------------------------------------------------------
-- ACCEPT_BOOKING_REQUEST
-- ------------------------------------------------------------
create or replace function public.accept_booking_request(
  p_merchant_id uuid,
  p_booking_id uuid,
  p_merchant_response_note text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking record;
  v_request_hash text;
  v_idem record;
  v_result jsonb;
  v_conflict record;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_merchant_id is null then
    raise exception 'not authenticated';
  end if;

  v_request_hash := md5(coalesce(p_booking_id::text, '') || '|' || coalesce(p_merchant_response_note, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_merchant_id and operation = 'accept_booking_request' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select id, listing_id, status, expires_at, start_at, end_at
  into v_booking
  from public.bookings
  where id = p_booking_id and merchant_id = p_merchant_id and status = 'requested'
  for update;

  if v_booking.id is null then
    raise exception 'booking not found, not owned by caller, or not in requested status';
  end if;
  if v_booking.expires_at is not null and v_booking.expires_at < now() then
    raise exception 'this request has expired and can no longer be accepted';
  end if;

  begin
    update public.bookings
    set status = 'accepted', accepted_at = now(), merchant_response_note = p_merchant_response_note, version = version + 1
    where id = p_booking_id;
  exception when exclusion_violation then
    raise exception 'this listing is no longer available for the requested dates';
  end;

  insert into public.booking_history (booking_id, actor_user_id, actor_role, event_type, previous_status, new_status, metadata)
  values (p_booking_id, p_merchant_id, 'merchant', 'booking_accepted', 'requested', 'accepted', jsonb_build_object('merchant_response_note', p_merchant_response_note));

  for v_conflict in
    select id from public.bookings
    where listing_id = v_booking.listing_id
      and status = 'requested'
      and id <> p_booking_id
      and tstzrange(start_at, end_at, '[)') && tstzrange(v_booking.start_at, v_booking.end_at, '[)')
  loop
    update public.bookings
    set status = 'rejected', rejected_at = now(), rejection_reason = 'Listing no longer available for these dates -- a conflicting booking was accepted', version = version + 1
    where id = v_conflict.id;

    insert into public.booking_history (booking_id, actor_user_id, actor_role, event_type, previous_status, new_status, metadata)
    values (v_conflict.id, null, 'system', 'booking_auto_rejected_conflict', 'requested', 'rejected', jsonb_build_object('conflicting_booking_id', p_booking_id));
  end loop;

  v_result := jsonb_build_object('booking_id', p_booking_id, 'status', 'accepted');

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_merchant_id, 'accept_booking_request', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

-- ------------------------------------------------------------
-- REJECT_BOOKING_REQUEST
-- ------------------------------------------------------------
create or replace function public.reject_booking_request(
  p_merchant_id uuid,
  p_booking_id uuid,
  p_rejection_reason text default null,
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
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_merchant_id is null then
    raise exception 'not authenticated';
  end if;

  v_request_hash := md5(coalesce(p_booking_id::text, '') || '|' || coalesce(p_rejection_reason, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_merchant_id and operation = 'reject_booking_request' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  if not exists (
    select 1 from public.bookings
    where id = p_booking_id and merchant_id = p_merchant_id and status = 'requested'
  ) then
    raise exception 'booking not found, not owned by caller, or not in requested status';
  end if;

  update public.bookings
  set status = 'rejected', rejected_at = now(), rejection_reason = p_rejection_reason, version = version + 1
  where id = p_booking_id;

  insert into public.booking_history (booking_id, actor_user_id, actor_role, event_type, previous_status, new_status, metadata)
  values (p_booking_id, p_merchant_id, 'merchant', 'booking_rejected', 'requested', 'rejected', jsonb_build_object('rejection_reason', p_rejection_reason));

  v_result := jsonb_build_object('booking_id', p_booking_id, 'status', 'rejected');

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_merchant_id, 'reject_booking_request', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

-- ------------------------------------------------------------
-- CANCEL_BOOKING -- actor role (renter vs merchant) is derived from the
-- booking row itself, never taken as a client-suppliable parameter.
-- ------------------------------------------------------------
create or replace function public.cancel_booking(
  p_actor_user_id uuid,
  p_booking_id uuid,
  p_cancellation_reason text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking record;
  v_request_hash text;
  v_idem record;
  v_new_status booking_status;
  v_notice_hours int;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_actor_user_id is null then
    raise exception 'not authenticated';
  end if;

  v_request_hash := md5(coalesce(p_booking_id::text, '') || '|' || coalesce(p_cancellation_reason, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_actor_user_id and operation = 'cancel_booking' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select id, renter_id, merchant_id, status, start_at, terms_snapshot
  into v_booking
  from public.bookings
  where id = p_booking_id and (renter_id = p_actor_user_id or merchant_id = p_actor_user_id);

  if v_booking.id is null then
    raise exception 'booking not found or you are not a party to it';
  end if;

  if v_booking.renter_id = p_actor_user_id then
    if v_booking.status = 'requested' then
      v_new_status := 'cancelled_by_renter';
    elsif v_booking.status = 'accepted' then
      v_notice_hours := (v_booking.terms_snapshot->>'renter_cancellation_notice_hours')::int;
      if v_notice_hours is not null and now() > v_booking.start_at - make_interval(hours => v_notice_hours) then
        raise exception 'the cancellation notice period for this booking has passed';
      end if;
      v_new_status := 'cancelled_by_renter';
    else
      raise exception 'booking cannot be cancelled in its current status';
    end if;
  else
    if v_booking.status = 'requested' then
      raise exception 'use reject for a requested booking, not cancel';
    elsif v_booking.status = 'accepted' then
      v_notice_hours := (v_booking.terms_snapshot->>'merchant_cancellation_notice_hours')::int;
      if v_notice_hours is not null and now() > v_booking.start_at - make_interval(hours => v_notice_hours) then
        raise exception 'the cancellation notice period for this booking has passed';
      end if;
      v_new_status := 'cancelled_by_merchant';
    elsif v_booking.status = 'active' then
      raise exception 'active bookings can only be cancelled through an administrative process';
    else
      raise exception 'booking cannot be cancelled in its current status';
    end if;
  end if;

  update public.bookings
  set status = v_new_status, cancelled_at = now(), cancelled_by = p_actor_user_id,
      cancellation_reason = p_cancellation_reason, version = version + 1
  where id = p_booking_id;

  insert into public.booking_history (booking_id, actor_user_id, actor_role, event_type, previous_status, new_status, metadata)
  values (
    p_booking_id, p_actor_user_id,
    case when v_booking.renter_id = p_actor_user_id then 'renter' else 'merchant' end,
    'booking_cancelled', v_booking.status, v_new_status,
    jsonb_build_object('cancellation_reason', p_cancellation_reason, 'settlement_status', 'not_applicable_no_payment_collected')
  );

  v_result := jsonb_build_object('booking_id', p_booking_id, 'status', v_new_status, 'settlement_status', 'not_applicable_no_payment_collected');

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_actor_user_id, 'cancel_booking', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

-- ------------------------------------------------------------
-- START_RENTAL
-- ------------------------------------------------------------
create or replace function public.start_rental(
  p_actor_user_id uuid,
  p_booking_id uuid,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking record;
  v_request_hash text;
  v_idem record;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_actor_user_id is null then
    raise exception 'not authenticated';
  end if;

  v_request_hash := md5(coalesce(p_booking_id::text, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_actor_user_id and operation = 'start_rental' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select id, renter_id, merchant_id, start_at, end_at
  into v_booking
  from public.bookings
  where id = p_booking_id and (renter_id = p_actor_user_id or merchant_id = p_actor_user_id) and status = 'accepted';

  if v_booking.id is null then
    raise exception 'booking not found, not owned by caller, or not in accepted status';
  end if;
  if now() < v_booking.start_at - interval '2 hours' then
    raise exception 'too early to start this rental';
  end if;
  if now() > v_booking.end_at then
    raise exception 'this booking''s rental window has already passed';
  end if;

  update public.bookings
  set status = 'active', rental_started_at = now(), version = version + 1
  where id = p_booking_id;

  insert into public.booking_history (booking_id, actor_user_id, actor_role, event_type, previous_status, new_status)
  values (p_booking_id, p_actor_user_id, case when v_booking.renter_id = p_actor_user_id then 'renter' else 'merchant' end, 'rental_started', 'accepted', 'active');

  v_result := jsonb_build_object('booking_id', p_booking_id, 'status', 'active');

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_actor_user_id, 'start_rental', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

-- ------------------------------------------------------------
-- INITIATE_RETURN
-- ------------------------------------------------------------
create or replace function public.initiate_return(
  p_actor_user_id uuid,
  p_booking_id uuid,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking record;
  v_request_hash text;
  v_idem record;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_actor_user_id is null then
    raise exception 'not authenticated';
  end if;

  v_request_hash := md5(coalesce(p_booking_id::text, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_actor_user_id and operation = 'initiate_return' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select id, renter_id, merchant_id into v_booking
  from public.bookings
  where id = p_booking_id and (renter_id = p_actor_user_id or merchant_id = p_actor_user_id) and status = 'active';

  if v_booking.id is null then
    raise exception 'booking not found, not owned by caller, or not in active status';
  end if;

  update public.bookings
  set status = 'return_pending', return_initiated_at = now(), return_initiated_by = p_actor_user_id, version = version + 1
  where id = p_booking_id;

  insert into public.booking_history (booking_id, actor_user_id, actor_role, event_type, previous_status, new_status)
  values (p_booking_id, p_actor_user_id, case when v_booking.renter_id = p_actor_user_id then 'renter' else 'merchant' end, 'return_initiated', 'active', 'return_pending');

  v_result := jsonb_build_object('booking_id', p_booking_id, 'status', 'return_pending');

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_actor_user_id, 'initiate_return', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

-- ------------------------------------------------------------
-- CONFIRM_RETURN -- must be the counterparty to whoever initiated the
-- return. Moves return_pending -> returned -> completed atomically
-- (both transitions recorded in history from a single caller action --
-- there is no separate "complete" step or route in this phase, since
-- nothing further gates completion once return is confirmed).
-- ------------------------------------------------------------
create or replace function public.confirm_return(
  p_actor_user_id uuid,
  p_booking_id uuid,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking record;
  v_request_hash text;
  v_idem record;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_actor_user_id is null then
    raise exception 'not authenticated';
  end if;

  v_request_hash := md5(coalesce(p_booking_id::text, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_actor_user_id and operation = 'confirm_return' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select id, renter_id, merchant_id, return_initiated_by into v_booking
  from public.bookings
  where id = p_booking_id and (renter_id = p_actor_user_id or merchant_id = p_actor_user_id) and status = 'return_pending';

  if v_booking.id is null then
    raise exception 'booking not found, not owned by caller, or not in return_pending status';
  end if;
  if v_booking.return_initiated_by = p_actor_user_id then
    raise exception 'the other party must confirm the return, not the party who initiated it';
  end if;

  update public.bookings set status = 'returned', returned_at = now(), version = version + 1 where id = p_booking_id;

  insert into public.booking_history (booking_id, actor_user_id, actor_role, event_type, previous_status, new_status)
  values (p_booking_id, p_actor_user_id, case when v_booking.renter_id = p_actor_user_id then 'renter' else 'merchant' end, 'return_confirmed', 'return_pending', 'returned');

  update public.bookings set status = 'completed', completed_at = now(), version = version + 1 where id = p_booking_id;

  insert into public.booking_history (booking_id, actor_user_id, actor_role, event_type, previous_status, new_status)
  values (p_booking_id, p_actor_user_id, case when v_booking.renter_id = p_actor_user_id then 'renter' else 'merchant' end, 'booking_completed', 'returned', 'completed');

  v_result := jsonb_build_object('booking_id', p_booking_id, 'status', 'completed');

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_actor_user_id, 'confirm_return', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

-- ------------------------------------------------------------
-- EXPIRE_STALE_BOOKING_REQUESTS -- no user-supplied identity; sweeps all
-- unanswered requests past their expiry. Naturally idempotent (a booking
-- already moved out of 'requested' is simply not matched again). Callable
-- only by service_role -- intended for a future scheduled process; no
-- public HTTP route exposes it this phase (see docs/BOOKING_LIFECYCLE.md).
-- ------------------------------------------------------------
create or replace function public.expire_stale_booking_requests()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int := 0;
  v_row record;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;

  for v_row in
    select id from public.bookings
    where status = 'requested' and expires_at is not null and expires_at < now()
    for update skip locked
  loop
    update public.bookings set status = 'expired', version = version + 1 where id = v_row.id;

    insert into public.booking_history (booking_id, actor_user_id, actor_role, event_type, previous_status, new_status)
    values (v_row.id, null, 'system', 'booking_expired', 'requested', 'expired');

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

-- ------------------------------------------------------------
-- GRANTS -- service_role only, matching submit_listing_for_review.
-- ------------------------------------------------------------
revoke all on function public.create_booking_request(uuid, uuid, timestamptz, timestamptz, text, text) from public, anon, authenticated;
revoke all on function public.accept_booking_request(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.reject_booking_request(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.cancel_booking(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.start_rental(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.initiate_return(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.confirm_return(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.expire_stale_booking_requests() from public, anon, authenticated;

grant execute on function public.create_booking_request(uuid, uuid, timestamptz, timestamptz, text, text) to service_role;
grant execute on function public.accept_booking_request(uuid, uuid, text, text) to service_role;
grant execute on function public.reject_booking_request(uuid, uuid, text, text) to service_role;
grant execute on function public.cancel_booking(uuid, uuid, text, text) to service_role;
grant execute on function public.start_rental(uuid, uuid, text) to service_role;
grant execute on function public.initiate_return(uuid, uuid, text) to service_role;
grant execute on function public.confirm_return(uuid, uuid, text) to service_role;
grant execute on function public.expire_stale_booking_requests() to service_role;
