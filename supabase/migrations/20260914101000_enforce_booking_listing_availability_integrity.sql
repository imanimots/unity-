-- ============================================================
-- Fix-forward: enforce cross-table availability/booking integrity.
-- ============================================================
-- Closes three compounding defects found during the Blocked-Date Integrity
-- audit (source-only, never applied to any live database prior to this):
--
-- 1. create_booking_request()'s merchant-blocked-date UX pre-check used a
--    bare `start_date < p_end_at::date and end_date > p_start_at::date`
--    predicate -- a same-day block never conflicted with a booking
--    starting on that day, and the ::date cast depended on the Postgres
--    session's TimeZone setting rather than any explicit, correct
--    calendar-day authority.
-- 2. No code path ever rechecked listing_availability before a booking
--    entered a blocking status (accepted/active) -- not at acceptance,
--    not at dispute-resolution restore, not at dispute-cancellation
--    restore -- so a merchant blocking dates after a request was created
--    (but before it was accepted) could not prevent that request from
--    later being accepted into an overlapping range.
-- 3. listing_availability can be written directly by an authenticated
--    merchant via PostgREST (RLS INSERT/DELETE, no status restriction,
--    no RPC gate) with zero check against existing bookings at all -- an
--    exclusion constraint on listing_availability alone cannot fix this,
--    since a Postgres EXCLUDE constraint can only compare rows of the
--    table it is defined on, never rows of a different table.
--
-- Fix: one symmetric, table-free interval predicate
-- (_booking_overlaps_availability_period) is the single source of truth
-- for "does this booking interval conflict with this merchant-blocked
-- calendar range", called identically from create_booking_request()'s UX
-- pre-check and from a trigger on EACH table, both locking the shared
-- public.listings row before their cross-table check -- so the guarantee
-- holds regardless of write path (RPC or direct client) and regardless of
-- which side commits first. Historical audit confirmed zero existing
-- conflicting (booking, availability) pairs across the current live data
-- (261 blocking bookings x 16 availability ranges inspected, 0 conflicts)
-- -- this migration adds no repair/backfill logic because none is needed.
--
-- accept_booking_request(), resolve_dispute(), cancel_dispute(), and
-- save_listing_draft() are deliberately NOT replaced here -- the new
-- triggers protect every one of them automatically (they all write
-- through the same two tables), and save_listing_draft() can never even
-- reach a conflict (it only ever touches status='draft' listings, which
-- can never have an accepted/active booking in the first place, since
-- create_booking_request() requires status='active').
-- ============================================================

-- ------------------------------------------------------------
-- Symmetric overlap predicate -- pure, table-free. Both trigger
-- directions and create_booking_request()'s UX pre-check call this same
-- function so the interval math can never drift between the two
-- directions or between the early check and the authoritative one.
--
-- listing_availability.start_date/end_date are inclusive merchant
-- calendar dates; the canonical blocked range is
-- [start_date 00:00 Africa/Johannesburg, end_date + 1 day 00:00
-- Africa/Johannesburg) -- South Africa runs no DST, so this fixed named
-- zone is deterministic. `timestamp AT TIME ZONE 'Africa/Johannesburg'`
-- interprets the naive value as wall-clock local time in that zone and
-- returns the corresponding timestamptz instant -- never a bare ::date
-- cast, which would silently depend on the Postgres session's own
-- TimeZone setting instead of this explicit authority.
-- ------------------------------------------------------------
create or replace function public._booking_overlaps_availability_period(
  p_booking_start_at timestamptz,
  p_booking_end_at timestamptz,
  p_block_start_date date,
  p_block_end_date date
)
returns boolean
language sql
stable
as $$
  select
    tstzrange(p_booking_start_at, p_booking_end_at, '[)')
    &&
    tstzrange(
      (p_block_start_date::timestamp) at time zone 'Africa/Johannesburg',
      ((p_block_end_date + 1)::timestamp) at time zone 'Africa/Johannesburg',
      '[)'
    );
$$;

revoke all on function public._booking_overlaps_availability_period(timestamptz, timestamptz, date, date) from public, anon, authenticated;
grant execute on function public._booking_overlaps_availability_period(timestamptz, timestamptz, date, date) to service_role;

-- ------------------------------------------------------------
-- Booking-side trigger: fires whenever a row is entering, or already sits
-- in, a blocking status (accepted/active) with a range that could newly
-- conflict. Locks the parent listing row before reading
-- listing_availability so this is safe under concurrent availability
-- writes -- see the availability-side trigger below, which locks the
-- same row for the opposite direction.
-- ------------------------------------------------------------
create or replace function public.bookings_check_availability_conflict()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status not in ('accepted', 'active') then
    return new;
  end if;

  if tg_op = 'UPDATE'
     and old.status = new.status
     and old.listing_id = new.listing_id
     and old.start_at = new.start_at
     and old.end_at = new.end_at
  then
    return new;
  end if;

  perform 1 from public.listings where id = new.listing_id for update;

  if exists (
    select 1
    from public.listing_availability a
    where a.listing_id = new.listing_id
      and public._booking_overlaps_availability_period(new.start_at, new.end_at, a.start_date, a.end_date)
  ) then
    raise exception 'this listing is no longer available for the requested dates';
  end if;

  return new;
end;
$$;

drop trigger if exists bookings_check_availability_conflict_trg on public.bookings;
create trigger bookings_check_availability_conflict_trg
  before insert or update on public.bookings
  for each row execute procedure public.bookings_check_availability_conflict();

-- ------------------------------------------------------------
-- Availability-side trigger: fires on INSERT, or on UPDATE that changes
-- listing_id/start_date/end_date (a bare `reason` edit needs no check).
-- No DELETE trigger -- removing a block only loosens the constraint.
-- Moving a block's listing_id only needs checking against NEW.listing_id
-- -- the OLD listing simply loses a block, which never creates a new
-- conflict there.
-- ------------------------------------------------------------
create or replace function public.listing_availability_check_booking_conflict()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform 1 from public.listings where id = new.listing_id for update;

  if exists (
    select 1
    from public.bookings b
    where b.listing_id = new.listing_id
      and b.status in ('accepted', 'active')
      and public._booking_overlaps_availability_period(b.start_at, b.end_at, new.start_date, new.end_date)
  ) then
    raise exception 'this listing is no longer available for the requested dates';
  end if;

  return new;
end;
$$;

drop trigger if exists listing_availability_check_booking_conflict_trg on public.listing_availability;
create trigger listing_availability_check_booking_conflict_trg
  before insert or update of listing_id, start_date, end_date on public.listing_availability
  for each row execute procedure public.listing_availability_check_booking_conflict();

-- ------------------------------------------------------------
-- create_booking_request -- CREATE OR REPLACE, same signature. Copied
-- byte-for-byte from the current live body (20260904000006's definition,
-- confirmed as the true latest authority -- it, not 20260829000001,
-- carries the account-status-hardening calls) with ONLY the merchant-
-- blocked-date predicate replaced by the symmetric helper. Everything
-- else -- authorization, idempotency, KYC/account-status checks, listing
-- checks, pricing, the booking-vs-booking overlap check, insert fields,
-- error messages, grants -- is unchanged.
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
  v_rate_amount numeric(12,2);
  v_rate_unit text;
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

  select id, merchant_id, status, listing_type, daily_rate, weekly_rate, deposit_required, deposit_amount,
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

  perform public._assert_kyc_approved(p_renter_id, 'self');
  perform public._assert_kyc_approved(v_listing.merchant_id, 'counterparty');
  perform public._assert_account_status_permits_creation(p_renter_id, 'self');
  perform public._assert_account_status_permits_transaction(v_listing.merchant_id, 'counterparty');

  if exists (select 1 from public.barter_locked_listings where listing_id = p_listing_id) then
    raise exception 'this listing is currently committed to a barter agreement';
  end if;
  if exists (select 1 from public.rent_to_buy_locked_listings where listing_id = p_listing_id) then
    raise exception 'this listing is currently committed to a rent-to-buy agreement';
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
    select 1
    from public.listing_availability a
    where a.listing_id = p_listing_id
      and public._booking_overlaps_availability_period(p_start_at, p_end_at, a.start_date, a.end_date)
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

  if v_duration_days >= 7 and v_listing.weekly_rate is not null then
    v_rate_unit := 'weekly';
    v_rate_amount := round(v_listing.weekly_rate / 7, 2);
    v_subtotal := round(v_listing.weekly_rate / 7 * v_duration_days, 2);
  else
    v_rate_unit := 'daily';
    v_rate_amount := v_listing.daily_rate;
    v_subtotal := v_listing.daily_rate * v_duration_days;
  end if;

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
    'ZAR', v_rate_amount, v_rate_unit, v_duration_days, v_subtotal,
    v_deposit, 0, v_subtotal + v_deposit, v_subtotal,
    'v2', v_terms, 'v1'
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
-- CREATE OR REPLACE preserves the existing grants (service_role only).
