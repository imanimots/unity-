-- ============================================================
-- Phase 4 -- Available / Looking For: offer lifecycle + acceptance.
-- ============================================================
-- submit/withdraw/decline_marketplace_offer, plus the critical
-- accept_marketplace_offer -- concurrency-safe, creates a REAL order/
-- booking/barter_agreement via the EXISTING, unmodified creation RPCs
-- (create_order, create_booking_request + accept_booking_request,
-- propose_barter + accept_barter_offer). No parallel financial system.
--
-- _create_marketplace_backing_listing(): the one small additive helper
-- resolving the private-offer / barter-requester-side FK requirement
-- (Step B's documented design decision) -- inserts a minimal,
-- non-public-facing listing (never referenced by any public browse/
-- search query, since nothing links to it except the offer/agreement
-- that required it) satisfying listings_type_pricing_chk exactly:
-- listing_type='sale' for buy (sale_price set), 'rental' for rent
-- (daily_rate set), 'rental' with a nominal daily_rate=1 for barter
-- (barter itself never reads a listing's price).
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

create or replace function public._create_marketplace_backing_listing(
  p_owner_id uuid, p_transaction_type text, p_title text, p_category text, p_category_id uuid,
  p_country_id text, p_province text, p_city text, p_amount numeric, p_is_test boolean
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_listing_id uuid;
  v_listing_type listing_type;
begin
  v_listing_type := case when p_transaction_type = 'buy' then 'sale'::listing_type else 'rental'::listing_type end;

  insert into public.listings (
    merchant_id, country_id, province, city, title, category, category_id, condition, listing_type,
    daily_rate, sale_price, quantity_available, status, risk_tier, ownership_verified, condition_confirmed, is_test, direction
  ) values (
    p_owner_id, coalesce(p_country_id, 'ZA'), p_province, p_city, coalesce(p_title, 'Marketplace offer'), coalesce(p_category, 'general'), p_category_id, 'good', v_listing_type,
    case when v_listing_type = 'rental' then coalesce(p_amount, 1) else null end,
    case when v_listing_type = 'sale' then coalesce(p_amount, 0) else null end,
    1, 'active', 'low', false, true, coalesce(p_is_test, false), 'available'
  ) returning id into v_listing_id;

  return v_listing_id;
end;
$$;
revoke all on function public._create_marketplace_backing_listing(uuid, text, text, text, uuid, text, text, text, numeric, boolean) from public, anon, authenticated;
grant execute on function public._create_marketplace_backing_listing(uuid, text, text, text, uuid, text, text, text, numeric, boolean) to service_role;

-- ------------------------------------------------------------
-- SUBMIT OFFER -- responder creates a response. Commercial offer types
-- (everything except message_only) require approved KYC (Step I/AD).
-- ------------------------------------------------------------
create or replace function public.submit_marketplace_offer(
  p_responder_id uuid,
  p_request_id uuid,
  p_offer_type text,
  p_linked_listing_id uuid default null,
  p_amount numeric default null,
  p_currency text default 'ZAR',
  p_rental_start_date date default null,
  p_rental_end_date date default null,
  p_cash_adjustment numeric default null,
  p_message text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
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
$$;

-- ------------------------------------------------------------
-- WITHDRAW -- responder only, pending only.
-- ------------------------------------------------------------
create or replace function public.withdraw_marketplace_offer(
  p_actor_user_id uuid, p_offer_id uuid, p_idempotency_key text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_offer record;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  select * into v_offer from public.marketplace_request_offers where id = p_offer_id for update;
  if v_offer.id is null then raise exception 'offer not found'; end if;
  if v_offer.responder_id <> p_actor_user_id then raise exception 'not the owner of this offer'; end if;
  if v_offer.status <> 'pending' then raise exception 'offer is in status % and cannot be withdrawn from here', v_offer.status; end if;

  update public.marketplace_request_offers set status = 'withdrawn', withdrawn_at = now() where id = p_offer_id;
  perform public._marketplace_request_history(v_offer.request_id, p_offer_id, 'responder', p_actor_user_id, 'offer_withdrawn', 'pending', 'withdrawn');

  return jsonb_build_object('offer_id', p_offer_id, 'status', 'withdrawn');
end;
$$;

-- ------------------------------------------------------------
-- DECLINE -- requester only, pending only.
-- ------------------------------------------------------------
create or replace function public.decline_marketplace_offer(
  p_actor_user_id uuid, p_offer_id uuid, p_reason text default null, p_idempotency_key text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_offer record;
  v_request record;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  select * into v_offer from public.marketplace_request_offers where id = p_offer_id for update;
  if v_offer.id is null then raise exception 'offer not found'; end if;
  select * into v_request from public.marketplace_requests where id = v_offer.request_id;
  if v_request.requester_id <> p_actor_user_id then raise exception 'not the owner of this request'; end if;
  if v_offer.status <> 'pending' then raise exception 'offer is in status % and cannot be declined from here', v_offer.status; end if;

  update public.marketplace_request_offers set status = 'declined', declined_at = now() where id = p_offer_id;
  perform public._marketplace_request_history(v_offer.request_id, p_offer_id, 'requester', p_actor_user_id, 'offer_declined', 'pending', 'declined', jsonb_build_object('reason', p_reason));

  return jsonb_build_object('offer_id', p_offer_id, 'status', 'declined');
end;
$$;

-- ------------------------------------------------------------
-- ACCEPT -- the critical transition. Concurrency-safe: locks the
-- REQUEST row first (serializes all concurrent accept attempts across
-- every offer on this request), then the specific offer row. Exactly
-- one accept can ever win per request.
-- ------------------------------------------------------------
create or replace function public.accept_marketplace_offer(
  p_actor_user_id uuid, p_offer_id uuid, p_idempotency_key text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_request_id uuid;
  v_request record;
  v_offer record;
  v_listing record;
  v_responder_listing_id uuid;
  v_requester_listing_id uuid;
  v_order_result jsonb;
  v_booking_result jsonb;
  v_barter_result jsonb;
  v_terms jsonb;
  v_result jsonb;
  v_request_hash text;
  v_idem record;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  if p_actor_user_id is null then raise exception 'not authenticated'; end if;

  select request_id into v_request_id from public.marketplace_request_offers where id = p_offer_id;
  if v_request_id is null then raise exception 'offer not found'; end if;

  -- Lock order: request row first, then the specific offer row -- every
  -- concurrent accept attempt for ANY offer on this request serializes
  -- here, so only one can ever proceed past this point.
  select * into v_request from public.marketplace_requests where id = v_request_id for update;
  select * into v_offer from public.marketplace_request_offers where id = p_offer_id for update;

  if v_request.requester_id <> p_actor_user_id then raise exception 'not the owner of this request'; end if;
  if v_request.status not in ('active', 'offers_received') then
    raise exception 'request is in status % and is no longer accept-able', v_request.status;
  end if;
  if v_offer.status <> 'pending' then
    raise exception 'offer is in status % and can no longer be accepted', v_offer.status;
  end if;
  if v_offer.offer_type = 'message_only' then
    raise exception 'a message-only response cannot be accepted as a transaction';
  end if;

  v_request_hash := md5(coalesce(p_offer_id::text, ''));
  if p_idempotency_key is not null then
    select request_hash, result into v_idem from public.idempotency_keys
    where merchant_id = p_actor_user_id and operation = 'accept_marketplace_offer' and idempotency_key = p_idempotency_key;
    if found then
      if v_idem.request_hash is distinct from v_request_hash then raise exception 'idempotency key already used with a different request'; end if;
      return v_idem.result;
    end if;
  end if;

  -- Resolve the responder-side backing listing.
  if v_offer.linked_listing_id is not null then
    select id, status into v_listing from public.listings where id = v_offer.linked_listing_id;
    if v_listing.id is null or v_listing.status <> 'active' then
      raise exception 'linked listing is no longer available';
    end if;
    v_responder_listing_id := v_listing.id;
  else
    v_responder_listing_id := public._create_marketplace_backing_listing(
      v_offer.responder_id, v_request.transaction_type, v_request.title, v_request.category, v_request.category_id,
      v_request.country_id, v_request.province, v_request.city, coalesce(v_offer.amount, v_offer.cash_adjustment), v_request.is_test
    );
  end if;

  v_terms := jsonb_build_object(
    'offer_type', v_offer.offer_type, 'responder_listing_id', v_responder_listing_id,
    'amount', v_offer.amount, 'currency', v_offer.currency,
    'rental_start_date', v_offer.rental_start_date, 'rental_end_date', v_offer.rental_end_date,
    'cash_adjustment', v_offer.cash_adjustment
  );

  if v_request.transaction_type = 'buy' then
    v_order_result := public.create_order(v_request.requester_id, v_responder_listing_id, greatest(coalesce(v_request.quantity, 1), 1), null);
    v_terms := v_terms || jsonb_build_object('order_id', v_order_result->>'order_id');

  elsif v_request.transaction_type = 'rent' then
    v_booking_result := public.create_booking_request(
      v_request.requester_id, v_responder_listing_id,
      coalesce(v_offer.rental_start_date, v_request.start_date)::timestamptz,
      coalesce(v_offer.rental_end_date, v_request.end_date)::timestamptz,
      v_offer.message, null
    );
    perform public.accept_booking_request(v_offer.responder_id, (v_booking_result->>'booking_id')::uuid, 'Accepted via Looking For request match', null);
    v_terms := v_terms || jsonb_build_object('booking_id', v_booking_result->>'booking_id');

  else -- barter
    v_requester_listing_id := public._create_marketplace_backing_listing(
      v_request.requester_id, 'barter', v_request.barter_offer_description, v_request.category, v_request.category_id,
      v_request.country_id, v_request.province, v_request.city, null, v_request.is_test
    );
    v_barter_result := public.propose_barter(
      v_request.requester_id, v_responder_listing_id,
      array[v_responder_listing_id], array[v_requester_listing_id],
      coalesce(v_offer.cash_adjustment, 0), case when coalesce(v_offer.cash_adjustment, 0) > 0 then v_request.requester_id else null end,
      'meet_in_person', null, null, false, null, 'ZAR', null, v_offer.message, 72, null
    );
    perform public.accept_barter_offer(v_offer.responder_id, (v_barter_result->>'agreement_id')::uuid, 'mock', null);
    v_terms := v_terms || jsonb_build_object('barter_agreement_id', v_barter_result->>'agreement_id', 'requester_listing_id', v_requester_listing_id);
  end if;

  update public.marketplace_request_offers set status = 'accepted', accepted_at = now(), terms_snapshot = v_terms where id = p_offer_id;

  -- Auto-decline every other still-pending offer on this request.
  update public.marketplace_request_offers
  set status = 'declined', declined_at = now()
  where request_id = v_request_id and id <> p_offer_id and status = 'pending';

  insert into public.marketplace_request_history (request_id, offer_id, actor_role, actor_id, event_type, previous_status, new_status)
  select v_request_id, id, 'system', p_actor_user_id, 'offer_auto_declined_competing', 'pending', 'declined'
  from public.marketplace_request_offers where request_id = v_request_id and id <> p_offer_id and status = 'declined' and declined_at >= now() - interval '5 seconds';

  update public.marketplace_requests set status = 'matched', matched_at = now(), matched_offer_id = p_offer_id where id = v_request_id;

  perform public._marketplace_request_history(v_request_id, p_offer_id, 'requester', p_actor_user_id, 'offer_accepted', 'pending', 'accepted', v_terms);
  perform public._marketplace_request_history(v_request_id, null, 'system', p_actor_user_id, 'request_matched', v_request.status::text, 'matched');

  v_result := jsonb_build_object('offer_id', p_offer_id, 'request_id', v_request_id, 'status', 'accepted', 'terms', v_terms);
  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_actor_user_id, 'accept_marketplace_offer', p_idempotency_key, v_request_hash, v_result);
  end if;
  return v_result;
end;
$$;

revoke all on function public.submit_marketplace_offer(uuid, uuid, text, uuid, numeric, text, date, date, numeric, text, text) from public, anon, authenticated;
grant execute on function public.submit_marketplace_offer(uuid, uuid, text, uuid, numeric, text, date, date, numeric, text, text) to service_role;
revoke all on function public.withdraw_marketplace_offer(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.withdraw_marketplace_offer(uuid, uuid, text) to service_role;
revoke all on function public.decline_marketplace_offer(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.decline_marketplace_offer(uuid, uuid, text, text) to service_role;
revoke all on function public.accept_marketplace_offer(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.accept_marketplace_offer(uuid, uuid, text) to service_role;
