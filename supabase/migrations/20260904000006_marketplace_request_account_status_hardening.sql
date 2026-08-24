-- Marketplace request / commercial-transaction account-status hardening
-- (Wave 2D). The audit found that publish_marketplace_request,
-- submit_marketplace_offer, and every canonical commercial
-- transaction-creation/acceptance RPC (create_order, create_booking_request,
-- accept_booking_request, propose_barter, accept_barter_offer,
-- create_rent_to_buy_request, accept_rent_to_buy_request) check KYC
-- (_assert_kyc_approved / _rent_to_buy_assert_parties_verified) but never
-- profiles.account_status -- meaning a KYC-approved-but-restricted-or-
-- suspended account could still publish a new Looking For request, submit
-- a commercial offer, or have a transaction created/accepted through
-- accept_marketplace_offer's delegated calls, all without any
-- account-status check anywhere on the path (route layer has none either
-- for these routes).
--
-- Reuses the EXISTING, already-established two-tier account-status model
-- (src/lib/admin/account-status.ts, profile_account_status enum:
-- active/restricted/suspended) rather than inventing a new one:
--   - "creation" tier (blocks restricted OR suspended) -- mirrors
--     blockIfCannotCreate(), for the party INITIATING new commercial
--     activity (publishing a request, submitting a commercial offer,
--     buying, booking, proposing a trade, requesting rent-to-buy).
--   - "transaction" tier (blocks suspended only) -- mirrors
--     blockIfCannotTransact(), for a party being serviced by an
--     already-existing opportunity (a counterparty whose active
--     listing/request is engaged, or a party finalizing/accepting an
--     offer that already exists) -- restricted alone does not block this,
--     matching the established "restricted accounts may still service
--     existing obligations" product rule.
--
-- Product decision (confirmed explicitly for this phase): an
-- already-published active marketplace_request is NOT retroactively
-- touched if its owner later becomes restricted/suspended -- it stays
-- visible and offers can still be submitted against it, exactly mirroring
-- the existing, documented rule for listings/bookings ("never touched by
-- a restriction, only future actions are gated"). No new mechanism was
-- added for this -- there was none to add.
--
-- Draft creation (create_marketplace_request) is deliberately NOT gated,
-- matching this RPC's own existing "no KYC required at draft" design and
-- this phase's explicit scope: "restricted account cannot publish new
-- commercial supply/demand" -- publish is the gated action, not draft
-- save/edit.
--
-- Every modified function below is reproduced from its verified LIVE body
-- (fetched via pg_get_functiondef against the linked DEVELOPMENT project
-- immediately before writing this migration, per this repo's own
-- documented migration-file/live-DB drift history) with only the new
-- perform ... lines inserted at the same point each function already
-- calls _assert_kyc_approved / _rent_to_buy_assert_parties_verified --
-- no other line in any of these 9 functions was changed. All 9 keep
-- their existing signatures, so plain CREATE OR REPLACE is sufficient
-- (no DROP FUNCTION needed).

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
  if v_status in ('restricted', 'suspended') then
    raise exception 'account_restricted:%', p_relation;
  end if;
end;
$$;

revoke all on function public._assert_account_status_permits_creation(uuid, text) from public, anon, authenticated;
grant execute on function public._assert_account_status_permits_creation(uuid, text) to service_role;

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
  if v_status = 'suspended' then
    raise exception 'account_suspended:%', p_relation;
  end if;
end;
$$;

revoke all on function public._assert_account_status_permits_transaction(uuid, text) from public, anon, authenticated;
grant execute on function public._assert_account_status_permits_transaction(uuid, text) to service_role;

-- ============================================================
-- publish_marketplace_request
-- ============================================================
CREATE OR REPLACE FUNCTION public.publish_marketplace_request(p_actor_user_id uuid, p_request_id uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_request record;
  v_kyc text;
  v_active_count int;
  v_plan_id text;
  v_publication_limit int;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  if p_actor_user_id is null then raise exception 'not authenticated'; end if;

  select * into v_request from public.marketplace_requests where id = p_request_id for update;
  if v_request.id is null then raise exception 'request not found'; end if;
  if v_request.requester_id <> p_actor_user_id then raise exception 'not the owner of this request'; end if;
  if v_request.status <> 'draft' then raise exception 'request is in status % and cannot be published from here', v_request.status; end if;

  select kyc_status::text into v_kyc from public.profiles where id = p_actor_user_id;
  if v_kyc is distinct from 'approved' then
    raise exception 'verification_required: KYC approval is required to publish a request';
  end if;

  perform public._assert_account_status_permits_creation(p_actor_user_id, 'self');

  perform public._assert_not_publication_frozen(p_actor_user_id);

  if not v_request.is_test then
    v_active_count := public._lock_and_count_active_supply(p_actor_user_id);
    v_plan_id := public._get_effective_merchant_plan_id(p_actor_user_id);
    select active_publication_limit into v_publication_limit from public.merchant_subscription_plans where id = v_plan_id;
    if v_publication_limit is not null and v_active_count >= v_publication_limit then
      raise exception 'active_publication_limit_reached: the % plan allows up to % active published entities', v_plan_id, v_publication_limit;
    end if;
  end if;

  update public.marketplace_requests set status = 'active' where id = p_request_id;
  perform public._marketplace_request_history(p_request_id, null, 'requester', p_actor_user_id, 'published', 'draft', 'active');

  v_result := jsonb_build_object('request_id', p_request_id, 'status', 'active');
  return v_result;
end;
$function$;

-- ============================================================
-- submit_marketplace_offer
-- ============================================================
CREATE OR REPLACE FUNCTION public.submit_marketplace_offer(p_responder_id uuid, p_request_id uuid, p_offer_type text, p_linked_listing_id uuid DEFAULT NULL::uuid, p_amount numeric DEFAULT NULL::numeric, p_currency text DEFAULT 'ZAR'::text, p_rental_start_date date DEFAULT NULL::date, p_rental_end_date date DEFAULT NULL::date, p_cash_adjustment numeric DEFAULT NULL::numeric, p_message text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_request record;
  v_listing record;
  v_kyc text;
  v_offer_id uuid;
  v_request_hash text;
  v_idem record;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  if p_responder_id is null then raise exception 'not authenticated'; end if;
  if p_offer_type not in ('link_listing', 'private_offer', 'message_only', 'public_listing') then
    raise exception 'invalid offer type';
  end if;

  select * into v_request from public.marketplace_requests where id = p_request_id;
  if v_request.id is null then raise exception 'request not found'; end if;
  if v_request.status not in ('active', 'offers_received') then
    raise exception 'request is in status % and is not accepting offers', v_request.status;
  end if;
  if v_request.requester_id = p_responder_id then
    raise exception 'cannot respond to your own request';
  end if;

  if p_offer_type <> 'message_only' then
    select kyc_status::text into v_kyc from public.profiles where id = p_responder_id;
    if v_kyc is distinct from 'approved' then
      raise exception 'verification_required: KYC approval is required to submit a commercial offer';
    end if;

    perform public._assert_account_status_permits_creation(p_responder_id, 'self');
  end if;

  if p_offer_type in ('link_listing', 'public_listing') then
    if p_linked_listing_id is null then raise exception 'a listing must be linked for this offer type'; end if;
    select id, merchant_id, status into v_listing from public.listings where id = p_linked_listing_id;
    if v_listing.id is null or v_listing.merchant_id <> p_responder_id then
      raise exception 'linked listing not found or not owned by you';
    end if;
    if v_listing.status <> 'active' then raise exception 'linked listing is not active'; end if;
  end if;

  v_request_hash := md5(coalesce(p_request_id::text,'') || '|' || coalesce(p_offer_type,'') || '|' || coalesce(p_linked_listing_id::text,'') || '|' || coalesce(p_amount::text,''));
  if p_idempotency_key is not null then
    select request_hash, result into v_idem from public.idempotency_keys
    where merchant_id = p_responder_id and operation = 'submit_marketplace_offer' and idempotency_key = p_idempotency_key;
    if found then
      if v_idem.request_hash is distinct from v_request_hash then raise exception 'idempotency key already used with a different request'; end if;
      return v_idem.result;
    end if;
  end if;

  insert into public.marketplace_request_offers (
    request_id, responder_id, offer_type, status, linked_listing_id, amount, currency,
    rental_start_date, rental_end_date, cash_adjustment, message, is_test
  ) values (
    p_request_id, p_responder_id, p_offer_type, 'pending', p_linked_listing_id, p_amount, coalesce(p_currency, 'ZAR'),
    p_rental_start_date, p_rental_end_date, p_cash_adjustment, p_message, v_request.is_test
  ) returning id into v_offer_id;

  if v_request.status = 'active' then
    update public.marketplace_requests set status = 'offers_received' where id = p_request_id;
  end if;

  perform public._marketplace_request_history(p_request_id, v_offer_id, 'responder', p_responder_id, 'offer_submitted', v_request.status::text, 'pending', jsonb_build_object('offer_type', p_offer_type));

  v_result := jsonb_build_object('offer_id', v_offer_id, 'status', 'pending');
  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_responder_id, 'submit_marketplace_offer', p_idempotency_key, v_request_hash, v_result);
  end if;
  return v_result;
end;
$function$;

-- ============================================================
-- create_order
-- ============================================================
CREATE OR REPLACE FUNCTION public.create_order(p_buyer_id uuid, p_listing_id uuid, p_quantity integer DEFAULT 1, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  perform public._assert_account_status_permits_creation(p_buyer_id, 'self');
  perform public._assert_account_status_permits_transaction(v_listing.merchant_id, 'counterparty');

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
$function$;

-- ============================================================
-- create_booking_request
-- ============================================================
CREATE OR REPLACE FUNCTION public.create_booking_request(p_renter_id uuid, p_listing_id uuid, p_start_at timestamp with time zone, p_end_at timestamp with time zone, p_renter_message text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;

-- ============================================================
-- accept_booking_request
-- ============================================================
CREATE OR REPLACE FUNCTION public.accept_booking_request(p_merchant_id uuid, p_booking_id uuid, p_merchant_response_note text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text, p_payment_deadline_hours integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  perform public._assert_account_status_permits_transaction(p_merchant_id, 'self');
  perform public._assert_account_status_permits_transaction(v_booking.renter_id, 'counterparty');

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
$function$;

-- ============================================================
-- propose_barter
-- ============================================================
CREATE OR REPLACE FUNCTION public.propose_barter(p_proposer_id uuid, p_anchor_listing_id uuid DEFAULT NULL::uuid, p_party_a_listing_ids uuid[] DEFAULT '{}'::uuid[], p_party_b_listing_ids uuid[] DEFAULT '{}'::uuid[], p_cash_adjustment_amount numeric DEFAULT 0, p_cash_adjustment_payer uuid DEFAULT NULL::uuid, p_delivery_method text DEFAULT 'meet_in_person'::text, p_delivery_notes text DEFAULT NULL::text, p_delivery_responsibility text DEFAULT NULL::text, p_deposit_required boolean DEFAULT false, p_deposit_amount numeric DEFAULT NULL::numeric, p_deposit_currency text DEFAULT 'ZAR'::text, p_deposit_payer text DEFAULT NULL::text, p_message text DEFAULT NULL::text, p_expiry_hours integer DEFAULT 72, p_idempotency_key text DEFAULT NULL::text, p_anchor_skill_task_post_id uuid DEFAULT NULL::uuid, p_party_a_contributions jsonb DEFAULT NULL::jsonb, p_party_b_contributions jsonb DEFAULT NULL::jsonb, p_deposit_terms jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_request_hash text;
  v_idem record;
  v_anchor_owner uuid;
  v_anchor_status listing_status;
  v_anchor_post public.barter_skill_task_posts;
  v_agreement_id uuid;
  v_offer_id uuid;
  v_reference text;
  v_result jsonb;
  v_satisfies_source_kind boolean;
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
  if (p_anchor_listing_id is not null)::int + (p_anchor_skill_task_post_id is not null)::int <> 1 then
    raise exception 'exactly one of an anchor listing or an anchor Skill/Task post must be provided';
  end if;

  v_request_hash := md5(
    coalesce(p_anchor_listing_id::text, '') || '|' || coalesce(p_anchor_skill_task_post_id::text, '') || '|' ||
    coalesce(p_party_a_listing_ids::text, '') || '|' || coalesce(p_party_b_listing_ids::text, '') || '|' ||
    coalesce(p_party_a_contributions::text, '[]') || '|' || coalesce(p_party_b_contributions::text, '[]') || '|' ||
    coalesce(p_deposit_terms::text, '[]') || '|' ||
    coalesce(p_cash_adjustment_amount::text, '0') || '|' || coalesce(p_delivery_method, '') || '|' ||
    coalesce(p_deposit_amount::text, '') || '|' || coalesce(p_deposit_payer, '') || '|' || coalesce(p_message, '')
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

  if p_anchor_listing_id is not null then
    select merchant_id, status into v_anchor_owner, v_anchor_status from public.listings where id = p_anchor_listing_id;
    if v_anchor_owner is null then
      raise exception 'listing not found';
    end if;
    if v_anchor_status <> 'active' then
      raise exception 'this listing is not available for barter';
    end if;
  else
    select * into v_anchor_post from public.barter_skill_task_posts where id = p_anchor_skill_task_post_id for update;
    if v_anchor_post is null then
      raise exception 'post not found';
    end if;
    if v_anchor_post.direction = 'available' then
      if v_anchor_post.status <> 'active' then
        raise exception 'this Skill/Task is not currently available for barter';
      end if;
    else
      if v_anchor_post.status not in ('active', 'offers_received') then
        raise exception 'this request is no longer open for offers';
      end if;
    end if;
    v_anchor_owner := v_anchor_post.owner_id;
  end if;

  if v_anchor_owner = p_proposer_id then
    raise exception 'you cannot propose a trade against your own listing or post';
  end if;

  perform public._assert_kyc_approved(p_proposer_id, 'self');
  perform public._assert_kyc_approved(v_anchor_owner, 'counterparty');
  perform public._assert_account_status_permits_creation(p_proposer_id, 'self');
  perform public._assert_account_status_permits_transaction(v_anchor_owner, 'counterparty');

  if p_party_a_listing_ids is not null and array_length(p_party_a_listing_ids, 1) is not null then
    perform public.validate_barter_offer_side(p_party_a_listing_ids, v_anchor_owner, 'requested');
  end if;
  if p_party_b_listing_ids is not null and array_length(p_party_b_listing_ids, 1) is not null then
    perform public.validate_barter_offer_side(p_party_b_listing_ids, p_proposer_id, 'offered');
  end if;

  if coalesce(array_length(p_party_a_listing_ids, 1), 0) = 0 and coalesce(jsonb_array_length(p_party_a_contributions), 0) = 0 then
    raise exception 'at least one contribution must be offered from the requested side';
  end if;
  if coalesce(array_length(p_party_b_listing_ids, 1), 0) = 0 and coalesce(jsonb_array_length(p_party_b_contributions), 0) = 0 then
    raise exception 'at least one contribution must be offered from the offered side';
  end if;

  v_reference := public.generate_barter_reference();

  insert into public.barter_agreements (
    agreement_reference, anchor_listing_id, anchor_skill_task_post_id, source_skill_task_post_id,
    party_a_id, party_b_id, status, expires_at
  ) values (
    v_reference, p_anchor_listing_id, p_anchor_skill_task_post_id,
    case when v_anchor_post.direction = 'looking_for' then p_anchor_skill_task_post_id else null end,
    v_anchor_owner, p_proposer_id, 'proposed', now() + make_interval(hours => p_expiry_hours)
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

  perform public._insert_barter_skill_task_contributions(v_offer_id, p_party_a_contributions, v_anchor_owner);
  perform public._insert_barter_skill_task_contributions(v_offer_id, p_party_b_contributions, p_proposer_id);

  if p_deposit_terms is not null and jsonb_array_length(p_deposit_terms) > 0 then
    if coalesce(p_deposit_required, false) or p_deposit_amount is not null then
      raise exception 'cannot combine legacy deposit fields with deposit_terms in the same offer';
    end if;
    perform public._insert_barter_deposit_terms(v_offer_id, p_deposit_terms, v_anchor_owner, p_proposer_id);
    update public.barter_offers set deposit_required = false, deposit_amount = null, deposit_payer = null where id = v_offer_id;
  end if;

  if v_anchor_post.direction = 'looking_for' then
    select exists (
      select 1 from public.barter_offer_items where offer_id = v_offer_id and offered_by = p_proposer_id and kind = v_anchor_post.kind
    ) into v_satisfies_source_kind;
    if not v_satisfies_source_kind then
      raise exception 'your offer must include at least one % contribution to satisfy this request', v_anchor_post.kind;
    end if;

    insert into public.barter_skill_task_source_snapshots (
      agreement_id, kind, title, description, exclusions, materials_arrangement, evidence_expectations,
      delivery_mode, province, city, availability_notes, preferred_start_date, preferred_start_time, deadline,
      expected_duration_notes, desired_exchange_notes
    )
    select v_agreement_id, kind, title, description, exclusions, materials_arrangement, evidence_expectations,
      delivery_mode, province, city, availability_notes, preferred_start_date, preferred_start_time, deadline,
      expected_duration_notes, desired_exchange_notes
    from public.barter_skill_task_posts where id = p_anchor_skill_task_post_id;

    if v_anchor_post.status = 'active' then
      update public.barter_skill_task_posts set status = 'offers_received' where id = p_anchor_skill_task_post_id;
      insert into public.barter_skill_task_post_history (post_id, actor_user_id, actor_role, event_type, previous_status, new_status)
      values (p_anchor_skill_task_post_id, p_proposer_id, 'system', 'post_received_first_offer', 'active', 'offers_received');
    end if;
  end if;

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
$function$;

-- ============================================================
-- accept_barter_offer
-- ============================================================
CREATE OR REPLACE FUNCTION public.accept_barter_offer(p_actor_user_id uuid, p_agreement_id uuid, p_provider text DEFAULT 'mock'::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_request_hash text;
  v_idem record;
  v_agreement record;
  v_current_offer record;
  v_conflict record;
  v_result jsonb;
  v_source_post public.barter_skill_task_posts;
  v_contribution record;
  v_post public.barter_skill_task_posts;
  v_deposit_term record;
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
  perform public._assert_account_status_permits_transaction(p_actor_user_id, 'self');
  perform public._assert_account_status_permits_transaction(
    case when p_actor_user_id = v_agreement.party_a_id then v_agreement.party_b_id else v_agreement.party_a_id end,
    'counterparty'
  );

  -- Final-acceptance revalidation of every Available-supply reference.
  for v_contribution in
    select skill_task_post_id, offered_by, kind from public.barter_offer_items
    where offer_id = v_current_offer.id and skill_task_post_id is not null
  loop
    select * into v_post from public.barter_skill_task_posts where id = v_contribution.skill_task_post_id;
    if v_post is null or v_post.direction <> 'available' or v_post.status <> 'active'
       or v_post.owner_id <> v_contribution.offered_by or v_post.kind <> v_contribution.kind then
      raise exception 'a Skill/Task supply referenced by this offer is no longer available for acceptance -- it may have been paused, suspended, or archived since this offer was made';
    end if;
  end loop;

  -- One-winner race serialization for a Looking-For source post.
  if v_agreement.source_skill_task_post_id is not null then
    select * into v_source_post from public.barter_skill_task_posts where id = v_agreement.source_skill_task_post_id for update;
    if v_source_post.status not in ('active', 'offers_received') then
      raise exception 'the originating request is no longer open (%) -- another offer may already have been accepted', v_source_post.status;
    end if;
    update public.barter_skill_task_posts set status = 'matched' where id = v_agreement.source_skill_task_post_id;
    insert into public.barter_skill_task_post_history (post_id, actor_user_id, actor_role, event_type, previous_status, new_status)
    values (v_agreement.source_skill_task_post_id, p_actor_user_id, 'system', 'post_matched', v_source_post.status, 'matched');
  end if;

  update public.barter_offers set status = 'accepted' where id = v_current_offer.id;

  update public.barter_agreements set
    status = 'accepted',
    accepted_offer_id = v_current_offer.id,
    accepted_at = now()
  where id = p_agreement_id;

  -- Deposits: barter_deposit_terms rows are authoritative when
  -- present; otherwise the unchanged legacy single-field path runs.
  if exists (select 1 from public.barter_deposit_terms where offer_id = v_current_offer.id) then
    for v_deposit_term in select * from public.barter_deposit_terms where offer_id = v_current_offer.id loop
      perform public.create_barter_payment_intent(
        p_agreement_id, v_deposit_term.payer_id,
        case when v_deposit_term.payer_id = v_agreement.party_a_id then v_agreement.party_b_id else v_agreement.party_a_id end,
        'barter_deposit', v_deposit_term.amount, v_deposit_term.currency, p_provider
      );
    end loop;
  elsif v_current_offer.deposit_required then
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

  -- Strict milestone sequencing at acceptance: for each skill/task
  -- contribution, the lowest-sequence milestone becomes active, every
  -- later one stays pending (the partial unique index guarantees at
  -- most one active per contribution at the database level).
  update public.barter_contribution_milestones m
  set status = 'active'
  from (
    select distinct on (offer_item_id) id, offer_item_id
    from public.barter_contribution_milestones
    where offer_item_id in (select id from public.barter_offer_items where offer_id = v_current_offer.id)
    order by offer_item_id, sequence asc
  ) first_milestone
  where m.id = first_milestone.id;

  insert into public.barter_history (agreement_id, actor_user_id, actor_role, event_type, previous_status, new_status, metadata, idempotency_key)
  values (
    p_agreement_id, p_actor_user_id,
    case when p_actor_user_id = v_agreement.party_a_id then 'party_a' else 'party_b' end,
    'barter_accepted', v_agreement.status, 'accepted', jsonb_build_object('offer_id', v_current_offer.id), p_idempotency_key
  );

  -- Auto-cancel any OTHER still-open proposal referencing a listing
  -- now locked by this acceptance.
  for v_conflict in
    select distinct ba.id
    from public.barter_agreements ba
    join public.barter_offers bo on bo.id = ba.current_offer_id
    join public.barter_offer_items boi on boi.offer_id = bo.id
    where ba.id <> p_agreement_id
      and ba.status in ('proposed', 'countered')
      and boi.listing_id in (
        select listing_id from public.barter_offer_items where offer_id = v_current_offer.id and listing_id is not null
      )
  loop
    update public.barter_agreements
    set status = 'cancelled', cancelled_at = now(), cancellation_reason = 'A conflicting barter agreement involving one of the offered listings was accepted', cancellation_settlement = 'not_applicable'
    where id = v_conflict.id;

    insert into public.barter_history (agreement_id, actor_user_id, actor_role, event_type, previous_status, new_status, metadata)
    values (v_conflict.id, null, 'system', 'barter_auto_cancelled_listing_locked', 'proposed', 'cancelled', jsonb_build_object('locked_by_agreement_id', p_agreement_id));
  end loop;

  -- Same auto-cancel, generalized to the Looking-For source-post case.
  if v_agreement.source_skill_task_post_id is not null then
    for v_conflict in
      select id from public.barter_agreements
      where id <> p_agreement_id
        and source_skill_task_post_id = v_agreement.source_skill_task_post_id
        and status in ('proposed', 'countered')
    loop
      update public.barter_agreements
      set status = 'cancelled', cancelled_at = now(), cancellation_reason = 'A different offer against the same request was accepted', cancellation_settlement = 'not_applicable'
      where id = v_conflict.id;

      insert into public.barter_history (agreement_id, actor_user_id, actor_role, event_type, previous_status, new_status, metadata)
      values (v_conflict.id, null, 'system', 'barter_auto_cancelled_source_matched', 'proposed', 'cancelled', jsonb_build_object('matched_agreement_id', p_agreement_id));
    end loop;
  end if;

  v_result := jsonb_build_object('agreement_id', p_agreement_id, 'status', 'accepted');

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_actor_user_id, 'accept_barter_offer', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$function$;

-- ============================================================
-- create_rent_to_buy_request
-- ============================================================
CREATE OR REPLACE FUNCTION public.create_rent_to_buy_request(p_customer_id uuid, p_listing_id uuid, p_request_id uuid DEFAULT NULL::uuid, p_offer_id uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  perform public._assert_account_status_permits_creation(p_customer_id, 'self');
  perform public._assert_account_status_permits_transaction(v_listing.merchant_id, 'counterparty');

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
    possession_trigger_type, possession_trigger_value, rental_use_rate_amount, rental_use_rate_unit,
    wear_damage_standard, grace_period_days, return_window_days,
    is_test
  ) values (
    p_listing_id, v_listing.merchant_id, p_customer_id, p_request_id, p_offer_id, 'pending_merchant_acceptance', 'not_delivered', 'merchant_owned',
    v_terms.currency, v_terms.total_purchase_price, v_terms.installment_amount, v_terms.payment_frequency, v_terms.installment_count,
    v_terms.security_deposit_amount, v_terms.early_payoff_allowed, v_terms.early_payoff_policy, v_terms.default_cure_allowed, v_terms.cure_policy, v_terms.terms_version,
    v_terms.possession_trigger_type, v_terms.possession_trigger_value, v_terms.rental_use_rate_amount, v_terms.rental_use_rate_unit,
    v_terms.wear_damage_standard, v_terms.grace_period_days, v_terms.return_window_days,
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
$function$;

-- ============================================================
-- accept_rent_to_buy_request
-- ============================================================
CREATE OR REPLACE FUNCTION public.accept_rent_to_buy_request(p_merchant_id uuid, p_agreement_id uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_agreement record;
  v_listing record;
  v_plan_id text;
  v_plan record;
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
  perform public._assert_account_status_permits_transaction(v_agreement.merchant_id, 'self');
  perform public._assert_account_status_permits_transaction(v_agreement.customer_id, 'counterparty');

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

  -- Rule 29: applicable RENTAL commission rate is snapshotted at
  -- acceptance -- a later subscription upgrade/downgrade never rewrites
  -- an already-accepted agreement's rate.
  v_plan_id := public._get_effective_merchant_plan_id(v_agreement.merchant_id);
  select id, rental_commission_bps, commercial_version into v_plan from public.merchant_subscription_plans where id = v_plan_id;

  update public.listings set quantity_available = quantity_available - 1 where id = v_agreement.listing_id;
  update public.rent_to_buy_agreements
  set status = 'awaiting_first_payment', accepted_at = now(),
      rental_commission_rate_bps = v_plan.rental_commission_bps,
      commission_merchant_plan_id = v_plan.id,
      commission_plan_commercial_version = v_plan.commercial_version
  where id = p_agreement_id;
  perform public._rent_to_buy_history(p_agreement_id, 'merchant', p_merchant_id, 'accepted', 'pending_merchant_acceptance', 'awaiting_first_payment');

  v_result := jsonb_build_object('agreement_id', p_agreement_id, 'status', 'awaiting_first_payment');
  return v_result;
end;
$function$;

