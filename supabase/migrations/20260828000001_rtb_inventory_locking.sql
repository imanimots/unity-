-- ============================================================
-- Phase 5 corrective -- Rent-to-Buy: single-physical-item inventory
-- allocation safety.
-- ============================================================
-- Audit finding: listings.quantity_available IS a genuine, already-live
-- multi-quantity-aware mechanism (create_order/cancel_order already
-- decrement/restore it) -- but bookings and barter are unit-count-
-- agnostic and instead use a VIEW-based exclusive lock
-- (barter_locked_listings, 20260810000003) checked by create_order,
-- create_booking_request, and validate_barter_offer_side. RTB conceptually
-- claims ONE specific physical item forever (like barter, not like a
-- fungible sale pool), so it participates in BOTH existing mechanisms
-- rather than inventing a third:
--
--   - Sale direction: RTB reserves exactly 1 unit of quantity_available
--     at ACCEPT time (mirroring create_order's own decrement), restored
--     on a pre-payment cancel (mirroring cancel_order's own restore).
--     This makes "RTB blocks sale" / "sale blocks RTB" fall out of the
--     EXISTING quantity_available machinery with zero new concept, and
--     correctly generalizes to a quantity>1 listing (RTB claims one
--     unit, the remaining N-1 stay independently sellable).
--   - Rental/barter/RTB-vs-RTB direction: a new rent_to_buy_locked_listings
--     view, mirroring barter_locked_listings' exact shape, checked by
--     create_booking_request, validate_barter_offer_side, and
--     create_rent_to_buy_request/accept_rent_to_buy_request themselves.
--
-- Locking begins at ACCEPTANCE, not raw request-creation -- mirrors
-- barter_locked_listings' own "only the ACCEPTED offer locks" precedent
-- exactly (a mere proposal/request does not exclude other proposals).
--
-- Lifecycle (the view's WHERE clause encodes this directly):
--   pending_merchant_acceptance -> not locked (not yet committed)
--   cancelled                   -> not locked (safe pre-payment cancel)
--   awaiting_first_payment/active/disputed -> locked
--   defaulted + item still physically out   -> locked (Rule 5/6 --
--     ownership stays merchant_owned, but the item hasn't come back)
--   defaulted/voluntarily-returned + item physically back
--     (possession_status returned_to_merchant/recovered) -> unlocked
--     again, regardless of the top-level agreement status -- no
--     financial policy is invented here, only "is the item physically
--     present" is checked.
--   completed -> locked PERMANENTLY (ownership left the merchant --
--     Rule 4/17, the listing must never re-enter merchant inventory).
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

create view public.rent_to_buy_locked_listings as
select listing_id, id as agreement_id
from public.rent_to_buy_agreements
where
  status = 'completed'
  or (
    status not in ('pending_merchant_acceptance', 'cancelled')
    and possession_status not in ('returned_to_merchant', 'recovered')
  );

grant select on public.rent_to_buy_locked_listings to anon, authenticated;

-- ------------------------------------------------------------
-- validate_barter_offer_side -- CREATE OR REPLACE, same signature.
-- One new check alongside the existing barter_locked_listings check.
-- ------------------------------------------------------------
create or replace function public.validate_barter_offer_side(
  p_listing_ids uuid[],
  p_expected_owner uuid,
  p_side_label text
)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_listing_id uuid;
  v_seen uuid[] := '{}';
  v_owner uuid;
  v_status listing_status;
begin
  if p_listing_ids is null or array_length(p_listing_ids, 1) is null then
    raise exception 'at least one listing must be offered from the % side', p_side_label;
  end if;

  foreach v_listing_id in array p_listing_ids loop
    if v_listing_id = any(v_seen) then
      raise exception 'the same listing cannot be offered more than once in a single offer';
    end if;
    v_seen := array_append(v_seen, v_listing_id);

    select merchant_id, status into v_owner, v_status
    from public.listings
    where id = v_listing_id;

    if v_owner is null then
      raise exception 'one or more offered listings could not be found';
    end if;
    if v_owner <> p_expected_owner then
      raise exception 'a listing offered on the % side does not belong to that party', p_side_label;
    end if;
    if v_status <> 'active' then
      raise exception 'one or more offered listings are not yet active';
    end if;
    if exists (select 1 from public.barter_locked_listings where listing_id = v_listing_id) then
      raise exception 'one or more offered listings are currently committed to another barter agreement';
    end if;
    if exists (select 1 from public.rent_to_buy_locked_listings where listing_id = v_listing_id) then
      raise exception 'one or more offered listings are currently committed to a rent-to-buy agreement';
    end if;
  end loop;
end;
$$;
revoke all on function public.validate_barter_offer_side(uuid[], uuid, text) from public, anon, authenticated;
grant execute on function public.validate_barter_offer_side(uuid[], uuid, text) to service_role;

-- ------------------------------------------------------------
-- create_booking_request -- CREATE OR REPLACE, same signature
-- (last revised 20260810000010). One new check alongside the existing
-- barter_locked_listings check; every other line byte-identical.
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
-- create or replace preserves the existing grants (service_role only).

-- ------------------------------------------------------------
-- create_rent_to_buy_request -- CREATE OR REPLACE, same signature.
-- Adds barter-lock / RTB-lock / active-booking / quantity-available
-- eligibility checks. Does NOT decrement quantity_available here --
-- that happens at ACCEPT time (mirrors the "only acceptance commits"
-- philosophy the barter lock view already establishes), so a mere
-- pending request never removes stock another party could still claim.
-- ------------------------------------------------------------
create or replace function public.create_rent_to_buy_request(
  p_customer_id uuid,
  p_listing_id uuid,
  p_request_id uuid default null,
  p_offer_id uuid default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_terms record;
  v_listing record;
  v_agreement_id uuid;
  v_seq int;
  v_running_total numeric(12,2);
  v_this_amount numeric(12,2);
  v_due date;
  v_interval interval;
  v_request_hash text;
  v_idem record;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  if p_customer_id is null then raise exception 'not authenticated'; end if;

  select id, merchant_id, status, is_test, quantity_available into v_listing from public.listings where id = p_listing_id;
  if v_listing.id is null then raise exception 'listing not found'; end if;
  if v_listing.merchant_id = p_customer_id then raise exception 'cannot enter a rent-to-buy agreement on your own listing'; end if;
  if v_listing.status <> 'active' then raise exception 'listing is not currently active'; end if;

  select * into v_terms from public.rent_to_buy_listing_terms where listing_id = p_listing_id and enabled = true;
  if v_terms.id is null then raise exception 'this listing does not have rent-to-buy enabled'; end if;

  if exists (select 1 from public.barter_locked_listings where listing_id = p_listing_id) then
    raise exception 'this listing is currently committed to a barter agreement';
  end if;
  if exists (select 1 from public.rent_to_buy_locked_listings where listing_id = p_listing_id) then
    raise exception 'this listing is currently committed to another rent-to-buy agreement';
  end if;
  if exists (
    select 1 from public.bookings
    where listing_id = p_listing_id
      and status not in ('rejected', 'expired', 'cancelled_by_renter', 'cancelled_by_merchant', 'completed')
  ) then
    raise exception 'this listing currently has an active rental booking';
  end if;
  if coalesce(v_listing.quantity_available, 0) < 1 then
    raise exception 'this listing has no remaining inventory available';
  end if;

  perform public._rent_to_buy_assert_parties_verified(v_listing.merchant_id, p_customer_id);

  v_request_hash := md5(coalesce(p_listing_id::text, '') || '|' || coalesce(p_customer_id::text, '') || '|' || coalesce(v_terms.terms_version::text, ''));
  if p_idempotency_key is not null then
    select request_hash, result into v_idem from public.idempotency_keys
    where merchant_id = p_customer_id and operation = 'create_rent_to_buy_request' and idempotency_key = p_idempotency_key;
    if found then
      if v_idem.request_hash is distinct from v_request_hash then raise exception 'idempotency key already used with a different request'; end if;
      return v_idem.result;
    end if;
  end if;

  insert into public.rent_to_buy_agreements (
    listing_id, merchant_id, customer_id, request_id, offer_id, status, possession_status, ownership_status,
    currency, total_purchase_price, installment_amount, payment_frequency, installment_count,
    security_deposit_amount, early_payoff_allowed, early_payoff_policy, cure_allowed, cure_policy, terms_version,
    is_test
  ) values (
    p_listing_id, v_listing.merchant_id, p_customer_id, p_request_id, p_offer_id, 'pending_merchant_acceptance', 'not_delivered', 'merchant_owned',
    v_terms.currency, v_terms.total_purchase_price, v_terms.installment_amount, v_terms.payment_frequency, v_terms.installment_count,
    v_terms.security_deposit_amount, v_terms.early_payoff_allowed, v_terms.early_payoff_policy, v_terms.default_cure_allowed, v_terms.cure_policy, v_terms.terms_version,
    coalesce(v_listing.is_test, false)
  ) returning id into v_agreement_id;

  v_interval := case v_terms.payment_frequency
    when 'weekly' then interval '7 days'
    when 'biweekly' then interval '14 days'
    else interval '1 month'
  end;

  v_due := current_date + v_interval;
  v_running_total := 0;
  for v_seq in 1..v_terms.installment_count loop
    if v_seq = v_terms.installment_count then
      v_this_amount := v_terms.total_purchase_price - v_running_total;
    else
      v_this_amount := round(v_terms.total_purchase_price / v_terms.installment_count, 2);
    end if;
    v_running_total := v_running_total + v_this_amount;

    insert into public.rent_to_buy_installments (agreement_id, sequence, due_date, principal_amount, status)
    values (v_agreement_id, v_seq, v_due, v_this_amount, 'scheduled');

    if v_seq = 1 then
      update public.rent_to_buy_agreements set first_due_date = v_due where id = v_agreement_id;
    end if;
    if v_seq = v_terms.installment_count then
      update public.rent_to_buy_agreements set final_due_date = v_due where id = v_agreement_id;
    end if;

    v_due := v_due + v_interval;
  end loop;

  perform public._rent_to_buy_history(v_agreement_id, 'customer', p_customer_id, 'requested', null, 'pending_merchant_acceptance');

  v_result := jsonb_build_object('agreement_id', v_agreement_id, 'status', 'pending_merchant_acceptance');
  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_customer_id, 'create_rent_to_buy_request', p_idempotency_key, v_request_hash, v_result);
  end if;
  return v_result;
end;
$$;

-- ------------------------------------------------------------
-- accept_rent_to_buy_request -- CREATE OR REPLACE, same signature.
-- Re-checks every lock (defense in depth -- something else could have
-- claimed the listing between request-creation and merchant-accept),
-- THEN commits by decrementing quantity_available by exactly 1. This
-- is the actual moment the item becomes allocated.
-- ------------------------------------------------------------
create or replace function public.accept_rent_to_buy_request(
  p_merchant_id uuid, p_agreement_id uuid, p_idempotency_key text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_agreement record;
  v_listing record;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  select * into v_agreement from public.rent_to_buy_agreements where id = p_agreement_id for update;
  if v_agreement.id is null then raise exception 'agreement not found'; end if;
  if v_agreement.merchant_id <> p_merchant_id then raise exception 'not the merchant of this agreement'; end if;
  if v_agreement.status <> 'pending_merchant_acceptance' then
    raise exception 'agreement is in status % and cannot be accepted from here', v_agreement.status;
  end if;

  perform public._rent_to_buy_assert_parties_verified(v_agreement.merchant_id, v_agreement.customer_id);

  select id, quantity_available into v_listing from public.listings where id = v_agreement.listing_id for update;
  if exists (select 1 from public.barter_locked_listings where listing_id = v_agreement.listing_id) then
    raise exception 'this listing is currently committed to a barter agreement';
  end if;
  if exists (select 1 from public.rent_to_buy_locked_listings where listing_id = v_agreement.listing_id and agreement_id <> p_agreement_id) then
    raise exception 'this listing is currently committed to another rent-to-buy agreement';
  end if;
  if exists (
    select 1 from public.bookings
    where listing_id = v_agreement.listing_id
      and status not in ('rejected', 'expired', 'cancelled_by_renter', 'cancelled_by_merchant', 'completed')
  ) then
    raise exception 'this listing currently has an active rental booking';
  end if;
  if coalesce(v_listing.quantity_available, 0) < 1 then
    raise exception 'this listing has no remaining inventory available';
  end if;

  update public.listings set quantity_available = quantity_available - 1 where id = v_agreement.listing_id;
  update public.rent_to_buy_agreements set status = 'awaiting_first_payment', accepted_at = now() where id = p_agreement_id;
  perform public._rent_to_buy_history(p_agreement_id, 'merchant', p_merchant_id, 'accepted', 'pending_merchant_acceptance', 'awaiting_first_payment');

  v_result := jsonb_build_object('agreement_id', p_agreement_id, 'status', 'awaiting_first_payment');
  return v_result;
end;
$$;

-- ------------------------------------------------------------
-- cancel_rent_to_buy_request -- CREATE OR REPLACE, same signature.
-- Restores the reserved unit ONLY when cancelling from
-- 'awaiting_first_payment' (the only status where accept_rent_to_buy_request
-- already decremented it) -- a cancel from 'pending_merchant_acceptance'
-- never touched inventory in the first place.
-- ------------------------------------------------------------
create or replace function public.cancel_rent_to_buy_request(
  p_actor_user_id uuid, p_agreement_id uuid, p_reason text default null, p_idempotency_key text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_agreement record;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  select * into v_agreement from public.rent_to_buy_agreements where id = p_agreement_id for update;
  if v_agreement.id is null then raise exception 'agreement not found'; end if;
  if v_agreement.customer_id <> p_actor_user_id and v_agreement.merchant_id <> p_actor_user_id then
    raise exception 'not a party to this agreement';
  end if;
  if v_agreement.status not in ('pending_merchant_acceptance', 'awaiting_first_payment') then
    raise exception 'agreement is in status % and cannot be cancelled from here', v_agreement.status;
  end if;

  if v_agreement.status = 'awaiting_first_payment' then
    update public.listings set quantity_available = quantity_available + 1 where id = v_agreement.listing_id;
  end if;

  update public.rent_to_buy_agreements set status = 'cancelled', cancelled_at = now(), cancelled_reason = p_reason where id = p_agreement_id;
  perform public._rent_to_buy_history(p_agreement_id, case when p_actor_user_id = v_agreement.merchant_id then 'merchant' else 'customer' end, p_actor_user_id, 'cancelled', v_agreement.status::text, 'cancelled', jsonb_build_object('reason', p_reason));
  return jsonb_build_object('agreement_id', p_agreement_id, 'status', 'cancelled');
end;
$$;

-- ------------------------------------------------------------
-- confirm_rent_to_buy_return_completed -- CREATE OR REPLACE, same
-- signature. Restores 1 unit of inventory the moment the item is
-- physically confirmed back with the merchant (Rule 16) -- the same
-- restoration this migration's rent_to_buy_locked_listings view already
-- reflects on the view-based-lock side.
-- ------------------------------------------------------------
create or replace function public.confirm_rent_to_buy_return_completed(
  p_admin_id uuid, p_case_id uuid, p_idempotency_key text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_case record;
  v_agreement record;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  select * into v_case from public.rent_to_buy_return_cases where id = p_case_id for update;
  if v_case.id is null then raise exception 'return case not found'; end if;
  if v_case.status not in ('requested', 'scheduled') then raise exception 'return case is in status % and cannot be confirmed returned from here', v_case.status; end if;

  select * into v_agreement from public.rent_to_buy_agreements where id = v_case.agreement_id for update;

  update public.rent_to_buy_return_cases set status = 'returned', resolved_at = now() where id = p_case_id;
  update public.rent_to_buy_agreements set possession_status = 'returned_to_merchant' where id = v_case.agreement_id;

  -- Only restore inventory if this agreement had actually reserved a
  -- unit (i.e. it reached acceptance) and ownership never transferred
  -- (a completed/customer_owned agreement's unit is permanently gone --
  -- Rule 17 -- this branch can't reach that state in practice since a
  -- completed agreement's possession is never 'return_required', but
  -- the ownership_status check is kept as an explicit, defense-in-depth
  -- guard against ever restoring stock for an item the merchant no
  -- longer owns).
  if v_agreement.ownership_status = 'merchant_owned' and v_agreement.status <> 'pending_merchant_acceptance' then
    update public.listings set quantity_available = quantity_available + 1 where id = v_agreement.listing_id;
  end if;

  perform public._rent_to_buy_history(v_case.agreement_id, 'admin', p_admin_id, 'return_confirmed', 'return_in_progress', 'returned_to_merchant', jsonb_build_object('case_id', p_case_id));

  return jsonb_build_object('case_id', p_case_id, 'agreement_id', v_case.agreement_id, 'possession_status', 'returned_to_merchant');
end;
$$;

-- ------------------------------------------------------------
-- confirm_rent_to_buy_recovered -- CREATE OR REPLACE, same signature.
-- Same inventory-restoration reasoning as confirm_rent_to_buy_return_completed.
-- ------------------------------------------------------------
create or replace function public.confirm_rent_to_buy_recovered(
  p_admin_id uuid, p_case_id uuid, p_idempotency_key text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_case record;
  v_agreement record;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  select * into v_case from public.rent_to_buy_return_cases where id = p_case_id for update;
  if v_case.id is null then raise exception 'return case not found'; end if;
  if v_case.case_type <> 'recovery' then raise exception 'this case is not a recovery case'; end if;
  if v_case.status <> 'recovery_pending' then raise exception 'recovery case is in status % and cannot be marked recovered from here', v_case.status; end if;

  select * into v_agreement from public.rent_to_buy_agreements where id = v_case.agreement_id for update;

  update public.rent_to_buy_return_cases set status = 'recovered', resolved_at = now() where id = p_case_id;
  update public.rent_to_buy_agreements set possession_status = 'recovered' where id = v_case.agreement_id;

  if v_agreement.ownership_status = 'merchant_owned' and v_agreement.status <> 'pending_merchant_acceptance' then
    update public.listings set quantity_available = quantity_available + 1 where id = v_agreement.listing_id;
  end if;

  perform public._rent_to_buy_history(v_case.agreement_id, 'admin', p_admin_id, 'recovery_confirmed', 'return_required', 'recovered', jsonb_build_object('case_id', p_case_id));

  return jsonb_build_object('case_id', p_case_id, 'agreement_id', v_case.agreement_id, 'possession_status', 'recovered');
end;
$$;
