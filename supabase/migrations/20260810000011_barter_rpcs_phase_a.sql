-- ============================================================
-- Barter marketplace (Phase 4) — Phase A RPCs
-- ============================================================
-- propose_barter / counter_barter_offer / accept_barter_offer /
-- reject_barter_offer / cancel_barter_agreement / expire_stale_barter_proposals.
--
-- Deliberately scoped to Phase A only, per the phased delivery plan --
-- payments (deposits/cash adjustments) don't exist yet (that's
-- 20260810000006, Phase B), so accept_barter_offer here locks listings
-- and transitions status but does not create any payment intent, and
-- cancel_barter_agreement records a cancellation_settlement value
-- descriptively without actually moving any money yet (nothing to move
-- in Phase A). Both will be `create or replace`d in Phase B once
-- payments.barter_agreement_id exists, exactly the same "revise in
-- place once a later phase needs more" pattern already used for
-- accept_booking_request (revised twice: weekly-rate alignment, then
-- payment-readiness).
--
-- Every RPC follows the exact skeleton from
-- 20260730000007_booking_rpcs.sql: security definer, set search_path =
-- public, auth.role() <> 'service_role' hard-blocked, idempotency via
-- the existing idempotency_keys table (hash-then-check-then-insert-
-- after-success), actor role/party derived from the row -- never a
-- client-claimed role param.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

-- ─────────────────────────────────────────
-- Internal helpers (plain functions, not part of the public RPC surface
-- -- called only from within the security definer RPCs below, so they
-- run with the caller's already-established definer privileges).
-- ─────────────────────────────────────────

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
  end loop;
end;
$$;

create or replace function public.insert_barter_offer_items(
  p_offer_id uuid,
  p_listing_ids uuid[],
  p_offered_by uuid
)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_listing_id uuid;
begin
  foreach v_listing_id in array p_listing_ids loop
    insert into public.barter_offer_items (offer_id, listing_id, offered_by)
    values (p_offer_id, v_listing_id, p_offered_by);
  end loop;
end;
$$;

-- ─────────────────────────────────────────
-- propose_barter
-- ─────────────────────────────────────────
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

-- ─────────────────────────────────────────
-- counter_barter_offer
-- ─────────────────────────────────────────
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

-- ─────────────────────────────────────────
-- accept_barter_offer
-- ─────────────────────────────────────────
create or replace function public.accept_barter_offer(
  p_actor_user_id uuid,
  p_agreement_id uuid,
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

  v_request_hash := md5(coalesce(p_agreement_id::text, ''));

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

  update public.barter_offers set status = 'accepted' where id = v_current_offer.id;

  update public.barter_agreements set
    status = 'accepted',
    accepted_offer_id = v_current_offer.id,
    accepted_at = now()
  where id = p_agreement_id;

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

-- ─────────────────────────────────────────
-- reject_barter_offer
-- ─────────────────────────────────────────
create or replace function public.reject_barter_offer(
  p_actor_user_id uuid,
  p_agreement_id uuid,
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
  v_agreement record;
  v_current_offer record;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_actor_user_id is null then
    raise exception 'not authenticated';
  end if;

  v_request_hash := md5(coalesce(p_agreement_id::text, '') || '|' || coalesce(p_rejection_reason, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_actor_user_id and operation = 'reject_barter_offer' and idempotency_key = p_idempotency_key;

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
    raise exception 'this offer can no longer be rejected';
  end if;

  select * into v_current_offer from public.barter_offers where id = v_agreement.current_offer_id;

  if v_current_offer.proposed_by = p_actor_user_id then
    raise exception 'it is not your turn to respond to this offer';
  end if;

  update public.barter_offers set status = 'rejected' where id = v_current_offer.id;

  update public.barter_agreements set
    status = 'rejected',
    rejected_at = now(),
    rejected_by = p_actor_user_id,
    rejection_reason = p_rejection_reason
  where id = p_agreement_id;

  insert into public.barter_history (agreement_id, actor_user_id, actor_role, event_type, previous_status, new_status, metadata, idempotency_key)
  values (
    p_agreement_id, p_actor_user_id,
    case when p_actor_user_id = v_agreement.party_a_id then 'party_a' else 'party_b' end,
    'barter_rejected', v_agreement.status, 'rejected', jsonb_build_object('rejection_reason', p_rejection_reason), p_idempotency_key
  );

  v_result := jsonb_build_object('agreement_id', p_agreement_id, 'status', 'rejected');

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_actor_user_id, 'reject_barter_offer', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

-- ─────────────────────────────────────────
-- cancel_barter_agreement (Phase A: records cancellation_settlement
-- descriptively; does not yet move any payment row, since payments
-- don't exist until Phase B -- will be create-or-replace'd then to add
-- the actual transition_payment_status() loop).
-- ─────────────────────────────────────────
create or replace function public.cancel_barter_agreement(
  p_actor_user_id uuid,
  p_agreement_id uuid,
  p_cancellation_reason text default null,
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
  v_settlement text;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_actor_user_id is null then
    raise exception 'not authenticated';
  end if;

  v_request_hash := md5(coalesce(p_agreement_id::text, '') || '|' || coalesce(p_cancellation_reason, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_actor_user_id and operation = 'cancel_barter_agreement' and idempotency_key = p_idempotency_key;

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

  if v_agreement.status = 'disputed' then
    raise exception 'cannot cancel a disputed agreement';
  end if;
  if v_agreement.status in ('completed', 'cancelled', 'rejected', 'expired') then
    raise exception 'this agreement cannot be cancelled in its current status';
  end if;

  v_settlement := case
    when v_agreement.status in ('proposed', 'countered') then 'not_applicable'
    when v_agreement.status in ('accepted', 'preparing') then 'refunded'
    else 'frozen_pending_dispute' -- in_transit, awaiting_confirmation
  end;

  update public.barter_agreements set
    status = 'cancelled',
    cancelled_at = now(),
    cancelled_by = p_actor_user_id,
    cancellation_reason = p_cancellation_reason,
    cancellation_settlement = v_settlement
  where id = p_agreement_id;

  insert into public.barter_history (agreement_id, actor_user_id, actor_role, event_type, previous_status, new_status, metadata, idempotency_key)
  values (
    p_agreement_id, p_actor_user_id,
    case when p_actor_user_id = v_agreement.party_a_id then 'party_a' else 'party_b' end,
    'barter_cancelled', v_agreement.status, 'cancelled',
    jsonb_build_object('cancellation_reason', p_cancellation_reason, 'settlement', v_settlement), p_idempotency_key
  );

  v_result := jsonb_build_object('agreement_id', p_agreement_id, 'status', 'cancelled', 'settlement', v_settlement);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_actor_user_id, 'cancel_barter_agreement', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

-- ─────────────────────────────────────────
-- expire_stale_barter_proposals -- no identity param, cron-style sweep,
-- lazy-triggered like bookings' equivalent (no public route this phase).
-- ─────────────────────────────────────────
create or replace function public.expire_stale_barter_proposals()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_agreement record;
  v_count int := 0;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;

  for v_agreement in
    select id, status from public.barter_agreements
    where status in ('proposed', 'countered') and expires_at < now()
    for update skip locked
  loop
    update public.barter_agreements set status = 'expired' where id = v_agreement.id;

    insert into public.barter_history (agreement_id, actor_user_id, actor_role, event_type, previous_status, new_status)
    values (v_agreement.id, null, 'system', 'barter_expired', v_agreement.status, 'expired');

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

-- ─────────────────────────────────────────
-- Grants -- service_role only, exactly matching every existing RPC file.
-- ─────────────────────────────────────────
revoke all on function public.propose_barter(uuid, uuid, uuid[], uuid[], numeric, uuid, text, text, text, boolean, numeric, text, text, text, int, text) from public, anon, authenticated;
grant execute on function public.propose_barter(uuid, uuid, uuid[], uuid[], numeric, uuid, text, text, text, boolean, numeric, text, text, text, int, text) to service_role;

revoke all on function public.counter_barter_offer(uuid, uuid, uuid[], uuid[], numeric, uuid, text, text, text, boolean, numeric, text, text, text, int, text) from public, anon, authenticated;
grant execute on function public.counter_barter_offer(uuid, uuid, uuid[], uuid[], numeric, uuid, text, text, text, boolean, numeric, text, text, text, int, text) to service_role;

revoke all on function public.accept_barter_offer(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.accept_barter_offer(uuid, uuid, text) to service_role;

revoke all on function public.reject_barter_offer(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.reject_barter_offer(uuid, uuid, text, text) to service_role;

revoke all on function public.cancel_barter_agreement(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.cancel_barter_agreement(uuid, uuid, text, text) to service_role;

revoke all on function public.expire_stale_barter_proposals() from public, anon, authenticated;
grant execute on function public.expire_stale_barter_proposals() to service_role;

revoke all on function public.validate_barter_offer_side(uuid[], uuid, text) from public, anon, authenticated;
grant execute on function public.validate_barter_offer_side(uuid[], uuid, text) to service_role;

revoke all on function public.insert_barter_offer_items(uuid, uuid[], uuid) from public, anon, authenticated;
grant execute on function public.insert_barter_offer_items(uuid, uuid[], uuid) to service_role;
