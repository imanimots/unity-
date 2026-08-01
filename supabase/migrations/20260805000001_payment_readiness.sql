-- ============================================================
-- Payment readiness (Step 6)
-- ============================================================
-- Connects booking progression to financial readiness without coupling
-- booking status to a specific payment provider. No new booking_status
-- enum value is added -- an accepted-but-unpaid booking stays 'accepted'
-- (the contract is unchanged); "awaiting payment" is a presentation state
-- derived in TypeScript from payment_due_at + the existing Step 5
-- financial-readiness model (src/lib/checkout/financial-readiness.ts).
-- See docs/PAYMENT_READINESS.md.
--
-- Forward-only, additive to the schema introduced in
-- 20260730000004-007 (booking status/schema/security/RPCs) and
-- 20260801-20260802 (payments/financial_workflows). Nothing here rewrites
-- an already-applied migration.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

-- ------------------------------------------------------------
-- New columns. payment_due_at is set once, at acceptance, and never
-- extended by a replay or a repeated acceptance attempt (a booking can
-- only be accepted once -- accept_booking_request's own `status =
-- 'requested'` guard already makes a second acceptance impossible).
-- payment_expired_at is set once, by the unpaid-expiry sweep below, and
-- distinguishes a payment-driven expiry from the pre-existing
-- requested-request expiry (expires_at / expire_stale_booking_requests(),
-- Phase 2B) -- both produce booking_status 'expired', but only one sets
-- payment_expired_at.
-- ------------------------------------------------------------
alter table public.bookings
  add column if not exists payment_due_at timestamptz,
  add column if not exists payment_expired_at timestamptz;

create index if not exists bookings_accepted_payment_due_idx
  on public.bookings(payment_due_at) where status = 'accepted';

create index if not exists bookings_payment_expired_idx
  on public.bookings(payment_expired_at) where payment_expired_at is not null;

-- ------------------------------------------------------------
-- Privileged-field trigger (20260730000006_booking_security.sql) extended
-- to also protect the two new columns -- a non-service-role caller can
-- never set or clear either directly.
-- ------------------------------------------------------------
create or replace function public.protect_booking_privileged_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then
    if TG_OP = 'INSERT' then
      raise exception 'bookings must be created via the booking request RPC, not a direct insert';
    else
      new.status := old.status;
      new.renter_id := old.renter_id;
      new.merchant_id := old.merchant_id;
      new.listing_id := old.listing_id;
      new.start_at := old.start_at;
      new.end_at := old.end_at;
      new.currency := old.currency;
      new.rate_amount := old.rate_amount;
      new.rate_unit := old.rate_unit;
      new.duration_units := old.duration_units;
      new.subtotal_amount := old.subtotal_amount;
      new.deposit_amount_snapshot := old.deposit_amount_snapshot;
      new.platform_fee_amount := old.platform_fee_amount;
      new.renter_total_amount := old.renter_total_amount;
      new.merchant_proceeds_estimate := old.merchant_proceeds_estimate;
      new.price_calculation_version := old.price_calculation_version;
      new.terms_snapshot := old.terms_snapshot;
      new.terms_snapshot_version := old.terms_snapshot_version;
      new.requested_at := old.requested_at;
      new.accepted_at := old.accepted_at;
      new.rejected_at := old.rejected_at;
      new.expires_at := old.expires_at;
      new.cancelled_at := old.cancelled_at;
      new.cancelled_by := old.cancelled_by;
      new.rental_started_at := old.rental_started_at;
      new.return_initiated_at := old.return_initiated_at;
      new.returned_at := old.returned_at;
      new.completed_at := old.completed_at;
      new.payment_due_at := old.payment_due_at;
      new.payment_expired_at := old.payment_expired_at;
      new.version := old.version;
    end if;
  end if;
  return new;
end;
$$;

-- ------------------------------------------------------------
-- ACCEPT_BOOKING_REQUEST -- extended with a required
-- p_payment_deadline_hours parameter (appended with a default of null so
-- CREATE OR REPLACE stays signature-compatible; the null is rejected at
-- runtime, not silently accepted, so every real caller must pass a real
-- value). The authoritative number lives in exactly one place in
-- application code -- BOOKING_PAYMENT_DEADLINE_HOURS
-- (src/lib/bookings/payment-deadline.ts, read from the
-- BOOKING_PAYMENT_DEADLINE_HOURS env var) -- and is passed in explicitly
-- on every call; this function never hardcodes its own fallback duration.
--
-- payment_due_at = least(accepted_at + deadline, start_at) -- never after
-- start_at, per the product rule. No safety buffer is subtracted; none is
-- documented anywhere in this codebase, and the task instructs not to
-- invent one.
--
-- Idempotency is unchanged: the existing idempotency_keys replay (in the
-- calling route, before this RPC ever runs) already returns the
-- originally cached result verbatim for an exact key replay -- since
-- payment_due_at is included in that cached v_result, a replay always
-- reports the ORIGINAL deadline, never a newly computed one. A booking
-- that is already 'accepted' can never be accepted a second time (the
-- `status = 'requested'` guard below), so a *new* idempotency key against
-- an already-accepted booking cannot extend or replace its deadline
-- either -- it simply fails with "not in requested status".
-- ------------------------------------------------------------
create or replace function public.accept_booking_request(
  p_merchant_id uuid,
  p_booking_id uuid,
  p_merchant_response_note text default null,
  p_idempotency_key text default null,
  p_payment_deadline_hours integer default null
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
  v_payment_due_at timestamptz;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_merchant_id is null then
    raise exception 'not authenticated';
  end if;
  if p_payment_deadline_hours is null or p_payment_deadline_hours <= 0 then
    raise exception 'a positive payment deadline (hours) is required';
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

  v_payment_due_at := least(now() + make_interval(hours => p_payment_deadline_hours), v_booking.start_at);

  begin
    update public.bookings
    set status = 'accepted', accepted_at = now(), merchant_response_note = p_merchant_response_note,
        payment_due_at = v_payment_due_at, version = version + 1
    where id = p_booking_id;
  exception when exclusion_violation then
    raise exception 'this listing is no longer available for the requested dates';
  end;

  insert into public.booking_history (booking_id, actor_user_id, actor_role, event_type, previous_status, new_status, metadata)
  values (
    p_booking_id, p_merchant_id, 'merchant', 'booking_accepted', 'requested', 'accepted',
    jsonb_build_object('merchant_response_note', p_merchant_response_note, 'payment_due_at', v_payment_due_at, 'payment_deadline_hours', p_payment_deadline_hours)
  );

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

  v_result := jsonb_build_object('booking_id', p_booking_id, 'status', 'accepted', 'payment_due_at', v_payment_due_at);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_merchant_id, 'accept_booking_request', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

-- ------------------------------------------------------------
-- EXPIRE_UNPAID_ACCEPTED_BOOKINGS -- idempotent, concurrency-safe sweep.
-- Mirrors the exact `for update skip locked` shape of the pre-existing
-- expire_stale_booking_requests() (20260730000007_booking_rpcs.sql) so
-- two concurrent sweeps can never both transition the same booking.
--
-- The readiness check below is a narrow, read-only mirror of exactly the
-- two terminal facts src/lib/checkout/financial-readiness.ts's
-- deriveFinancialReadiness() also reads (payments.status for the rental
-- charge and, if required, the deposit) -- not a competing financial
-- model. It exists in SQL, rather than calling the TypeScript helper,
-- because the check-then-transition must be atomic within one statement
-- for concurrency safety (see docs/PAYMENT_READINESS.md "Unpaid-expiry
-- workflow"). It reads only public.payments.status values (a normalized,
-- provider-neutral enum) -- never a provider-specific field -- so it
-- never asks "did MockProvider succeed", only "is this payment captured".
--
-- Skips (does not expire) any booking that is actually financially ready,
-- even if its deadline has passed -- a booking that paid in time must
-- never be expired by a delayed sweep.
-- ------------------------------------------------------------
create or replace function public.expire_unpaid_accepted_bookings()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
  v_expired_count int := 0;
  v_skipped_ready_count int := 0;
  v_rental_status payment_status;
  v_deposit_status payment_status;
  v_deposit_required boolean;
  v_ready boolean;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;

  for v_row in
    select id, deposit_amount_snapshot from public.bookings
    where status = 'accepted' and payment_due_at is not null and payment_due_at < now()
    for update skip locked
  loop
    select status into v_rental_status from public.payments
      where booking_id = v_row.id and payment_type = 'rental_charge';

    v_deposit_required := coalesce(v_row.deposit_amount_snapshot, 0) > 0;
    if v_deposit_required then
      select status into v_deposit_status from public.payments
        where booking_id = v_row.id and payment_type = 'deposit';
    else
      v_deposit_status := null;
    end if;

    v_ready := (v_rental_status = 'captured') and (not v_deposit_required or v_deposit_status = 'authorised');

    if v_ready then
      v_skipped_ready_count := v_skipped_ready_count + 1;
      continue;
    end if;

    update public.bookings
    set status = 'expired', payment_expired_at = now(), version = version + 1
    where id = v_row.id;

    insert into public.booking_history (booking_id, actor_user_id, actor_role, event_type, previous_status, new_status, metadata)
    values (v_row.id, null, 'system', 'booking_payment_expired', 'accepted', 'expired', jsonb_build_object('reason', 'payment_deadline_passed'));

    v_expired_count := v_expired_count + 1;
  end loop;

  return jsonb_build_object('expired_count', v_expired_count, 'skipped_ready_count', v_skipped_ready_count);
end;
$$;

-- ------------------------------------------------------------
-- RECORD_LATE_PAYMENT_RECONCILIATION -- the smallest possible extension
-- for "a provider event/authorization completes after unpaid expiry".
-- Never changes booking status (an expired booking stays expired -- no
-- automatic reactivation), never touches payments/ledger (those already
-- correctly reflect the real captured/authorised state via the unchanged
-- Financial Orchestrator -- this only marks that the situation needs
-- manual review). Idempotent: at most one such marker per booking, so a
-- retried caller (e.g. a webhook redelivery) never creates a duplicate
-- review item.
-- ------------------------------------------------------------
create or replace function public.record_late_payment_reconciliation(
  p_booking_id uuid,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_already_recorded boolean;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_booking_id is null then
    raise exception 'booking id is required';
  end if;

  select exists(
    select 1 from public.booking_history
    where booking_id = p_booking_id and event_type = 'late_payment_reconciliation'
  ) into v_already_recorded;

  if not v_already_recorded then
    insert into public.booking_history (booking_id, actor_user_id, actor_role, event_type, previous_status, new_status, metadata)
    select id, null, 'system', 'late_payment_reconciliation', status, status, jsonb_build_object('note', p_note, 'requires_manual_review', true)
    from public.bookings where id = p_booking_id;
  end if;

  return jsonb_build_object('booking_id', p_booking_id, 'recorded', not v_already_recorded);
end;
$$;

-- ------------------------------------------------------------
-- GRANTS -- service_role only, matching every other booking RPC.
-- ------------------------------------------------------------
revoke all on function public.accept_booking_request(uuid, uuid, text, text, integer) from public, anon, authenticated;
grant execute on function public.accept_booking_request(uuid, uuid, text, text, integer) to service_role;

revoke all on function public.expire_unpaid_accepted_bookings() from public, anon, authenticated;
grant execute on function public.expire_unpaid_accepted_bookings() to service_role;

revoke all on function public.record_late_payment_reconciliation(uuid, text) from public, anon, authenticated;
grant execute on function public.record_late_payment_reconciliation(uuid, text) to service_role;
