-- ============================================================
-- Phase 4 -- fix-forward correction, found via live smoke testing.
-- ============================================================
-- accept_booking_request() exists as TWO overloaded functions:
--   (uuid, uuid, text, text)              -- from 20260730000007
--   (uuid, uuid, text, text, integer)     -- from 20260805000001
-- The second migration's CREATE OR REPLACE did not match the first
-- overload's exact parameter signature (it added
-- p_payment_deadline_hours), so instead of replacing it, Postgres kept
-- both as genuinely separate overloaded functions. The real application
-- (POST /api/bookings/[id]/accept) always calls with all 5 named
-- parameters, which resolves unambiguously to the newer overload --
-- this pre-existing duplicate has been silently dormant and harmless
-- until now. accept_marketplace_offer() calling it positionally with
-- only 4 arguments hit the ambiguity directly: "function
-- accept_booking_request(uuid, uuid, unknown, unknown) is not unique".
--
-- Confirmed via grep: no other code path in this codebase calls
-- accept_booking_request with fewer than 5 parameters -- dropping the
-- stale 4-param overload is safe and does not touch booking business
-- logic at all (it only removes a dead, ambiguity-causing duplicate).
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

drop function if exists public.accept_booking_request(uuid, uuid, text, text);

-- accept_marketplace_offer: CREATE OR REPLACE (same signature) with the
-- rent branch now calling accept_booking_request with all 5 named
-- parameters, matching the real application's own call shape exactly
-- (including a real payment deadline, not left at the RPC's own
-- default of none).
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
    perform public.accept_booking_request(
      p_merchant_id => v_offer.responder_id,
      p_booking_id => (v_booking_result->>'booking_id')::uuid,
      p_merchant_response_note => 'Accepted via Looking For request match',
      p_idempotency_key => null,
      p_payment_deadline_hours => 24
    );
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
