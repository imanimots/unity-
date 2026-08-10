-- ============================================================
-- Platform hardening -- merchant verification re-check at
-- transaction-entry time.
-- ============================================================
-- Rule: all commercial transactions require BOTH sides to still be
-- currently kyc_status = 'approved' at the moment a NEW commercial
-- transaction is created/accepted -- not merely at listing activation
-- time. A merchant's KYC can be revoked by an admin after their
-- listing was activated without the listing being deactivated
-- (confirmed live: activate_listing() checks kyc_status only once, at
-- activation; decide_identity_verification() never touches listings;
-- getListings() never filters on merchant KYC) -- so an existing
-- active listing can remain fully transactable even though the
-- merchant is no longer verified. Rent-to-Buy was already built
-- correctly (_rent_to_buy_assert_parties_verified(), checked live at
-- both create_rent_to_buy_request() and accept_rent_to_buy_request())
-- -- this migration generalizes that exact pattern to Buy/Rent/Barter,
-- deliberately left alone by name in RTB's own migration comment
-- ("a pre-existing gap in Buy/Rent/Barter, reported separately, not
-- fixed here").
--
-- Enforcement is placed inside the authoritative RPCs themselves (not
-- only the calling routes), per Step E's "deepest authoritative
-- transaction boundary" requirement -- this closes both the direct-RPC
-- bypass vector and, as a structural side effect with zero further
-- code changes, the accept_marketplace_offer() Looking For path, which
-- calls these same RPCs as plain internal function calls rather than
-- going back through the HTTP routes that carry the route-level
-- isKycApproved() checks.
--
-- One shared SQL primitive, not four hand-written duplicates: every
-- new check below calls the same public._assert_kyc_approved(). It
-- raises 'verification_required:self' when the ACTING user's own KYC
-- has lapsed, or 'verification_required:counterparty' when the OTHER
-- party's has -- letting the TS error mappers show a role-appropriate,
-- non-revealing message (never "ID document rejected"/"failed AML",
-- just "verification required" / "not currently available").
--
-- Deliberately NOT touched: create_rent_to_buy_request /
-- accept_rent_to_buy_request (already correct, left alone per Step I --
-- "do not rewrite working RTB verification merely for symmetry"),
-- submit_marketplace_offer / publish_marketplace_request (already
-- correct, out of scope), the risk engine's own inline check (separate
-- concern), listing activation (out of scope -- Step K says do not
-- mass-deactivate), and cancel/reject/dispute/refund/return/servicing
-- paths on ANY domain (Step L -- existing transactions must remain
-- fully serviceable regardless of the counterparty's current KYC).
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

-- ------------------------------------------------------------
-- public._assert_kyc_approved -- the one shared SQL KYC gate for
-- transaction-entry hardening. Reads current, live profiles.kyc_status
-- (never a cached/stale value, never trusts listing-activation
-- history). p_relation is exactly 'self' or 'counterparty' -- a
-- structural hint for the TS error mapper, not a detail leak (no KYC
-- reason, no document status, ever surfaces from this function).
-- ------------------------------------------------------------
create or replace function public._assert_kyc_approved(p_user_id uuid, p_relation text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kyc text;
begin
  select kyc_status::text into v_kyc from public.profiles where id = p_user_id;
  if v_kyc is distinct from 'approved' then
    raise exception 'verification_required:%', p_relation;
  end if;
end;
$$;

revoke all on function public._assert_kyc_approved(uuid, text) from public, anon, authenticated;
grant execute on function public._assert_kyc_approved(uuid, text) to service_role;

-- ------------------------------------------------------------
-- create_order -- CREATE OR REPLACE, same signature (last revised
-- 20260812000004). Adds live buyer + merchant KYC re-check right after
-- the listing is resolved and the self-purchase guard, before any
-- inventory-specific check. Every other line byte-identical.
-- ------------------------------------------------------------
create or replace function public.create_order(
  p_buyer_id uuid,
  p_listing_id uuid,
  p_quantity int default 1,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_listing record;
  v_request_hash text;
  v_idem record;
  v_order_id uuid;
  v_reference text;
  v_total numeric(12,2);
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_buyer_id is null then
    raise exception 'not authenticated';
  end if;
  if p_quantity is null or p_quantity < 1 then
    raise exception 'quantity must be at least 1';
  end if;

  v_request_hash := md5(coalesce(p_listing_id::text, '') || '|' || coalesce(p_quantity::text, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_buyer_id and operation = 'create_order' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  -- Row-locked for the duration of this transaction -- the actual
  -- guarantee against overselling is this lock plus the atomic decrement
  -- below, not the pre-check read on its own.
  select id, merchant_id, status, listing_type, sale_price, quantity_available, shipping_payer
  into v_listing
  from public.listings
  where id = p_listing_id
  for update;

  if v_listing.id is null or v_listing.status <> 'active' or v_listing.listing_type not in ('sale', 'both') or v_listing.sale_price is null then
    raise exception 'listing not found or not available for purchase';
  end if;
  if v_listing.merchant_id = p_buyer_id then
    raise exception 'you cannot buy your own listing';
  end if;

  perform public._assert_kyc_approved(p_buyer_id, 'self');
  perform public._assert_kyc_approved(v_listing.merchant_id, 'counterparty');

  if exists (select 1 from public.barter_locked_listings where listing_id = p_listing_id) then
    raise exception 'this listing is currently committed to a barter agreement';
  end if;
  if v_listing.quantity_available < p_quantity then
    raise exception 'insufficient stock available for the requested quantity';
  end if;

  update public.listings set quantity_available = quantity_available - p_quantity where id = p_listing_id;

  v_total := v_listing.sale_price * p_quantity; -- shipping_fee is always 0 this pass -- no shipping-cost model exists yet, see docs/BUYING_SELLING.md known limitations
  v_reference := public.generate_order_reference();

  insert into public.orders (
    order_reference, listing_id, buyer_id, seller_id, quantity, unit_price, shipping_fee, total_amount, status
  ) values (
    v_reference, p_listing_id, p_buyer_id, v_listing.merchant_id, p_quantity, v_listing.sale_price, 0, v_total, 'pending'
  )
  returning id into v_order_id;

  insert into public.order_history (order_id, actor_user_id, actor_role, event_type, new_status, metadata, idempotency_key)
  values (v_order_id, p_buyer_id, 'buyer', 'order_created', 'pending', jsonb_build_object('quantity', p_quantity, 'unit_price', v_listing.sale_price), p_idempotency_key);

  v_result := jsonb_build_object('order_id', v_order_id, 'order_reference', v_reference, 'status', 'pending', 'total_amount', v_total);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_buyer_id, 'create_order', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;
-- create or replace preserves the existing grants (service_role only).

-- ------------------------------------------------------------
-- create_booking_request -- CREATE OR REPLACE, same signature (last
-- revised 20260828000001). Adds live renter + merchant KYC re-check
-- right after the listing is resolved and the self-booking guard,
-- before the barter/RTB lock checks. Every other line byte-identical.
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
-- accept_booking_request -- CREATE OR REPLACE, same signature (last
-- revised 20260805000001). Adds renter_id to the locked select, plus a
-- live merchant + renter KYC re-check right after the booking is
-- resolved and confirmed not expired -- this is the second
-- verification checkpoint for Rent (Step G): a merchant approved when
-- the request was created can still have been revoked before they
-- click accept, and this closes exactly that window. Every other line
-- byte-identical.
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

  select id, listing_id, renter_id, status, expires_at, start_at, end_at
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

  perform public._assert_kyc_approved(p_merchant_id, 'self');
  perform public._assert_kyc_approved(v_booking.renter_id, 'counterparty');

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
-- create or replace preserves the existing grants (service_role only).

-- ------------------------------------------------------------
-- propose_barter -- CREATE OR REPLACE, same signature (last revised
-- 20260810000011). Adds live proposer + anchor-listing-owner KYC
-- re-check right after the anchor listing is resolved and the
-- self-proposal guard, before validate_barter_offer_side(). Every
-- other line byte-identical.
-- ------------------------------------------------------------
create or replace function public.propose_barter(
  p_proposer_id uuid,
  p_anchor_listing_id uuid,
  p_party_a_listing_ids uuid[],
  p_party_b_listing_ids uuid[],
  p_cash_adjustment_amount numeric default 0,
  p_cash_adjustment_payer uuid default null,
  p_delivery_method text default 'meet_in_person',
  p_delivery_notes text default null,
  p_delivery_responsibility text default null,
  p_deposit_required boolean default false,
  p_deposit_amount numeric default null,
  p_deposit_currency text default 'ZAR',
  p_deposit_payer text default null,
  p_message text default null,
  p_expiry_hours int default 72,
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
  v_anchor_owner uuid;
  v_anchor_status listing_status;
  v_agreement_id uuid;
  v_offer_id uuid;
  v_reference text;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_proposer_id is null then
    raise exception 'not authenticated';
  end if;
  if p_expiry_hours is null or p_expiry_hours <= 0 then
    raise exception 'invalid expiry window';
  end if;

  v_request_hash := md5(
    coalesce(p_anchor_listing_id::text, '') || '|' ||
    coalesce(p_party_a_listing_ids::text, '') || '|' ||
    coalesce(p_party_b_listing_ids::text, '') || '|' ||
    coalesce(p_cash_adjustment_amount::text, '0') || '|' ||
    coalesce(p_delivery_method, '') || '|' ||
    coalesce(p_deposit_amount::text, '') || '|' ||
    coalesce(p_deposit_payer, '') || '|' ||
    coalesce(p_message, '')
  );

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_proposer_id and operation = 'propose_barter' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select merchant_id, status into v_anchor_owner, v_anchor_status
  from public.listings
  where id = p_anchor_listing_id;

  if v_anchor_owner is null then
    raise exception 'listing not found';
  end if;
  if v_anchor_status <> 'active' then
    raise exception 'this listing is not available for barter';
  end if;
  if v_anchor_owner = p_proposer_id then
    raise exception 'you cannot propose a trade on your own listing';
  end if;

  perform public._assert_kyc_approved(p_proposer_id, 'self');
  perform public._assert_kyc_approved(v_anchor_owner, 'counterparty');

  perform public.validate_barter_offer_side(p_party_a_listing_ids, v_anchor_owner, 'requested');
  perform public.validate_barter_offer_side(p_party_b_listing_ids, p_proposer_id, 'offered');

  v_reference := public.generate_barter_reference();

  insert into public.barter_agreements (
    agreement_reference, anchor_listing_id, party_a_id, party_b_id, status, expires_at
  ) values (
    v_reference, p_anchor_listing_id, v_anchor_owner, p_proposer_id, 'proposed',
    now() + make_interval(hours => p_expiry_hours)
  )
  returning id into v_agreement_id;

  insert into public.barter_offers (
    agreement_id, version, proposed_by, status,
    cash_adjustment_amount, cash_adjustment_payer,
    delivery_method, delivery_notes, delivery_responsibility,
    deposit_required, deposit_amount, deposit_currency, deposit_payer,
    message
  ) values (
    v_agreement_id, 1, p_proposer_id, 'pending',
    coalesce(p_cash_adjustment_amount, 0), p_cash_adjustment_payer,
    p_delivery_method, p_delivery_notes, p_delivery_responsibility,
    coalesce(p_deposit_required, false), p_deposit_amount, coalesce(p_deposit_currency, 'ZAR'), p_deposit_payer,
    p_message
  )
  returning id into v_offer_id;

  update public.barter_agreements set current_offer_id = v_offer_id where id = v_agreement_id;

  perform public.insert_barter_offer_items(v_offer_id, p_party_a_listing_ids, v_anchor_owner);
  perform public.insert_barter_offer_items(v_offer_id, p_party_b_listing_ids, p_proposer_id);

  insert into public.barter_history (agreement_id, actor_user_id, actor_role, event_type, new_status, metadata, idempotency_key)
  values (v_agreement_id, p_proposer_id, 'party_b', 'barter_proposed', 'proposed', jsonb_build_object('offer_id', v_offer_id), p_idempotency_key);

  v_result := jsonb_build_object(
    'agreement_id', v_agreement_id,
    'agreement_reference', v_reference,
    'offer_id', v_offer_id,
    'status', 'proposed'
  );

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_proposer_id, 'propose_barter', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;
-- create or replace preserves the existing grants (service_role only).

-- ------------------------------------------------------------
-- counter_barter_offer -- CREATE OR REPLACE, same signature (last
-- revised 20260810000011). A counter changes and re-commits both
-- sides to new commercial terms, so both parties' live KYC is
-- re-checked right after the agreement is resolved/locked and the
-- turn-check, before validate_barter_offer_side(). Every other line
-- byte-identical.
-- ------------------------------------------------------------
create or replace function public.counter_barter_offer(
  p_actor_user_id uuid,
  p_agreement_id uuid,
  p_party_a_listing_ids uuid[],
  p_party_b_listing_ids uuid[],
  p_cash_adjustment_amount numeric default 0,
  p_cash_adjustment_payer uuid default null,
  p_delivery_method text default 'meet_in_person',
  p_delivery_notes text default null,
  p_delivery_responsibility text default null,
  p_deposit_required boolean default false,
  p_deposit_amount numeric default null,
  p_deposit_currency text default 'ZAR',
  p_deposit_payer text default null,
  p_message text default null,
  p_expiry_hours int default 72,
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
  v_agreement record;
  v_current_offer record;
  v_new_offer_id uuid;
  v_new_version int;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_actor_user_id is null then
    raise exception 'not authenticated';
  end if;
  if p_expiry_hours is null or p_expiry_hours <= 0 then
    raise exception 'invalid expiry window';
  end if;

  v_request_hash := md5(
    coalesce(p_agreement_id::text, '') || '|' ||
    coalesce(p_party_a_listing_ids::text, '') || '|' ||
    coalesce(p_party_b_listing_ids::text, '') || '|' ||
    coalesce(p_cash_adjustment_amount::text, '0') || '|' ||
    coalesce(p_delivery_method, '') || '|' ||
    coalesce(p_deposit_amount::text, '') || '|' ||
    coalesce(p_deposit_payer, '') || '|' ||
    coalesce(p_message, '')
  );

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_actor_user_id and operation = 'counter_barter_offer' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select * into v_agreement from public.barter_agreements where id = p_agreement_id for update;

  if v_agreement.id is null or (v_agreement.party_a_id <> p_actor_user_id and v_agreement.party_b_id <> p_actor_user_id) then
    raise exception 'barter agreement not found or you are not a party to it';
  end if;
  if v_agreement.admin_hold then
    raise exception 'this barter agreement is currently suspended by an administrator';
  end if;
  if v_agreement.status not in ('proposed', 'countered') then
    raise exception 'this offer can no longer be countered';
  end if;

  select * into v_current_offer from public.barter_offers where id = v_agreement.current_offer_id;

  if v_current_offer.proposed_by = p_actor_user_id then
    raise exception 'it is not your turn to respond to this offer';
  end if;

  perform public._assert_kyc_approved(p_actor_user_id, 'self');
  perform public._assert_kyc_approved(
    case when p_actor_user_id = v_agreement.party_a_id then v_agreement.party_b_id else v_agreement.party_a_id end,
    'counterparty'
  );

  perform public.validate_barter_offer_side(p_party_a_listing_ids, v_agreement.party_a_id, 'requested');
  perform public.validate_barter_offer_side(p_party_b_listing_ids, v_agreement.party_b_id, 'offered');

  update public.barter_offers set status = 'superseded' where id = v_current_offer.id;

  v_new_version := v_current_offer.version + 1;

  insert into public.barter_offers (
    agreement_id, version, proposed_by, status,
    cash_adjustment_amount, cash_adjustment_payer,
    delivery_method, delivery_notes, delivery_responsibility,
    deposit_required, deposit_amount, deposit_currency, deposit_payer,
    message
  ) values (
    p_agreement_id, v_new_version, p_actor_user_id, 'pending',
    coalesce(p_cash_adjustment_amount, 0), p_cash_adjustment_payer,
    p_delivery_method, p_delivery_notes, p_delivery_responsibility,
    coalesce(p_deposit_required, false), p_deposit_amount, coalesce(p_deposit_currency, 'ZAR'), p_deposit_payer,
    p_message
  )
  returning id into v_new_offer_id;

  perform public.insert_barter_offer_items(v_new_offer_id, p_party_a_listing_ids, v_agreement.party_a_id);
  perform public.insert_barter_offer_items(v_new_offer_id, p_party_b_listing_ids, v_agreement.party_b_id);

  update public.barter_agreements set
    status = 'countered',
    current_offer_id = v_new_offer_id,
    version = v_new_version,
    -- Fresh response window for this round, per the configurable-expiry
    -- rule: each valid counter resets the deadline, replay never does.
    expires_at = now() + make_interval(hours => p_expiry_hours)
  where id = p_agreement_id;

  insert into public.barter_history (agreement_id, actor_user_id, actor_role, event_type, previous_status, new_status, metadata, idempotency_key)
  values (
    p_agreement_id, p_actor_user_id,
    case when p_actor_user_id = v_agreement.party_a_id then 'party_a' else 'party_b' end,
    'barter_countered', v_agreement.status, 'countered', jsonb_build_object('offer_id', v_new_offer_id, 'version', v_new_version), p_idempotency_key
  );

  v_result := jsonb_build_object('agreement_id', p_agreement_id, 'offer_id', v_new_offer_id, 'version', v_new_version, 'status', 'countered');

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_actor_user_id, 'counter_barter_offer', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;
-- create or replace preserves the existing grants (service_role only).

-- ------------------------------------------------------------
-- accept_barter_offer -- CREATE OR REPLACE, same signature (last
-- revised 20260816000003). Both parties' live KYC re-checked right
-- after the agreement is resolved/locked and the turn-check, before
-- offer acceptance and payment-intent creation. Every other line
-- byte-identical.
-- ------------------------------------------------------------
create or replace function public.accept_barter_offer(
  p_actor_user_id uuid,
  p_agreement_id uuid,
  p_provider text default 'mock',
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
  v_agreement record;
  v_current_offer record;
  v_conflict record;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_actor_user_id is null then
    raise exception 'not authenticated';
  end if;

  v_request_hash := md5(coalesce(p_agreement_id::text, '') || '|' || coalesce(p_provider, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_actor_user_id and operation = 'accept_barter_offer' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select * into v_agreement from public.barter_agreements where id = p_agreement_id for update;

  if v_agreement.id is null or (v_agreement.party_a_id <> p_actor_user_id and v_agreement.party_b_id <> p_actor_user_id) then
    raise exception 'barter agreement not found or you are not a party to it';
  end if;
  if v_agreement.admin_hold then
    raise exception 'this barter agreement is currently suspended by an administrator';
  end if;
  if v_agreement.status not in ('proposed', 'countered') then
    raise exception 'this offer can no longer be accepted';
  end if;

  select * into v_current_offer from public.barter_offers where id = v_agreement.current_offer_id;

  if v_current_offer.proposed_by = p_actor_user_id then
    raise exception 'it is not your turn to respond to this offer';
  end if;

  perform public._assert_kyc_approved(p_actor_user_id, 'self');
  perform public._assert_kyc_approved(
    case when p_actor_user_id = v_agreement.party_a_id then v_agreement.party_b_id else v_agreement.party_a_id end,
    'counterparty'
  );

  update public.barter_offers set status = 'accepted' where id = v_current_offer.id;

  update public.barter_agreements set
    status = 'accepted',
    accepted_offer_id = v_current_offer.id,
    accepted_at = now()
  where id = p_agreement_id;

  -- Payment intents from the accepted offer's own terms (Step 11 Phase
  -- 4). Creating an intent is a plain DB insert -- no provider call --
  -- so it's safe to fold into this same transaction. Authorisation is a
  -- separate, explicit, payer-initiated action (POST /api/barter/[id]/
  -- deposit, /cash-adjustment).
  if v_current_offer.deposit_required then
    if v_current_offer.deposit_payer in ('party_a', 'both') then
      perform public.create_barter_payment_intent(
        p_agreement_id, v_agreement.party_a_id, v_agreement.party_b_id,
        'barter_deposit', v_current_offer.deposit_amount, v_current_offer.deposit_currency, p_provider
      );
    end if;
    if v_current_offer.deposit_payer in ('party_b', 'both') then
      perform public.create_barter_payment_intent(
        p_agreement_id, v_agreement.party_b_id, v_agreement.party_a_id,
        'barter_deposit', v_current_offer.deposit_amount, v_current_offer.deposit_currency, p_provider
      );
    end if;
  end if;

  if v_current_offer.cash_adjustment_amount > 0 then
    perform public.create_barter_payment_intent(
      p_agreement_id,
      v_current_offer.cash_adjustment_payer,
      case when v_current_offer.cash_adjustment_payer = v_agreement.party_a_id then v_agreement.party_b_id else v_agreement.party_a_id end,
      'barter_cash_adjustment', v_current_offer.cash_adjustment_amount, v_current_offer.deposit_currency, p_provider
    );
  end if;

  insert into public.barter_history (agreement_id, actor_user_id, actor_role, event_type, previous_status, new_status, metadata, idempotency_key)
  values (
    p_agreement_id, p_actor_user_id,
    case when p_actor_user_id = v_agreement.party_a_id then 'party_a' else 'party_b' end,
    'barter_accepted', v_agreement.status, 'accepted', jsonb_build_object('offer_id', v_current_offer.id), p_idempotency_key
  );

  -- Auto-cancel any OTHER still-open proposal that references a listing
  -- now locked by this acceptance -- mirrors accept_booking_request's
  -- conflict-reject loop over overlapping date ranges.
  for v_conflict in
    select distinct ba.id
    from public.barter_agreements ba
    join public.barter_offers bo on bo.id = ba.current_offer_id
    join public.barter_offer_items boi on boi.offer_id = bo.id
    where ba.id <> p_agreement_id
      and ba.status in ('proposed', 'countered')
      and boi.listing_id in (
        select listing_id from public.barter_offer_items where offer_id = v_current_offer.id
      )
  loop
    update public.barter_agreements
    set status = 'cancelled', cancelled_at = now(), cancellation_reason = 'A conflicting barter agreement involving one of the offered listings was accepted', cancellation_settlement = 'not_applicable'
    where id = v_conflict.id;

    insert into public.barter_history (agreement_id, actor_user_id, actor_role, event_type, previous_status, new_status, metadata)
    values (v_conflict.id, null, 'system', 'barter_auto_cancelled_listing_locked', 'proposed', 'cancelled', jsonb_build_object('locked_by_agreement_id', p_agreement_id));
  end loop;

  v_result := jsonb_build_object('agreement_id', p_agreement_id, 'status', 'accepted');

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_actor_user_id, 'accept_barter_offer', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;
-- create or replace preserves the existing grants (service_role only).
