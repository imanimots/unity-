-- ============================================================
-- Step 11 Phase 4 -- Barter Phase B RPCs
-- ============================================================
-- create_barter_payment_intent (internal helper, mirrors
-- create_order_payment_intent but as a plain function like
-- insert_barter_offer_items -- called only from within
-- accept_barter_offer's own security-definer context, so it doesn't
-- need its own idempotency guard: the outer function's idempotency
-- check already makes the whole acceptance-plus-intent-creation
-- operation atomic and replay-safe).
--
-- accept_barter_offer is CREATE OR REPLACE'd to additionally create
-- (never authorise -- that's a separate, explicit, payer-initiated
-- action) 0-3 payment intents from the just-accepted offer's own
-- deposit/cash-adjustment terms. A new p_provider parameter is added
-- (default 'mock', matching create_order_payment_intent's own
-- default) so the route can pass through PAYMENT_PROVIDER.
--
-- cancel_barter_agreement is deliberately NOT touched here -- see
-- docs/BARTER_EXECUTION.md "Deviation from the Phase A plan" for why
-- (money movement on cancellation happens in the JS orchestrator,
-- after this RPC, never inside a SQL function -- provider calls can't
-- happen in SQL, and this codebase never flips a payment to
-- released/captured without going through PaymentProvider first).
--
-- mark_barter_progress / confirm_barter_completion / admin_set_barter_hold
-- / admin_cancel_barter_agreement are new, following the exact same
-- skeleton every existing barter/dispute/order RPC uses: security
-- definer, service_role-only, idempotency via idempotency_keys,
-- actor role derived from the row.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

-- ─────────────────────────────────────────
-- create_barter_payment_intent -- internal helper only.
-- ─────────────────────────────────────────
create or replace function public.create_barter_payment_intent(
  p_agreement_id uuid,
  p_payer_id uuid,
  p_counterparty_id uuid,
  p_payment_type payment_type,
  p_amount numeric,
  p_currency text default 'ZAR',
  p_provider text default 'mock'
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_payment_id uuid;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'invalid amount';
  end if;
  if p_payment_type not in ('barter_deposit', 'barter_cash_adjustment') then
    raise exception 'invalid payment type for a barter payment intent';
  end if;

  insert into public.payments (barter_agreement_id, renter_id, merchant_id, payment_type, status, amount, currency, provider)
  values (p_agreement_id, p_payer_id, p_counterparty_id, p_payment_type, 'pending', p_amount, p_currency, p_provider)
  returning id into v_payment_id;

  insert into public.payment_events (payment_id, actor_type, event_type, previous_status, new_status)
  values (v_payment_id, 'system', 'payment_intent_created', null, 'pending');

  return v_payment_id;
end;
$$;

-- ─────────────────────────────────────────
-- accept_barter_offer -- unchanged acceptance logic, plus
-- payment-intent creation from the accepted offer's terms. This ADDS a
-- parameter (p_provider), which Postgres treats as a different function
-- signature -- CREATE OR REPLACE would silently create an overload
-- alongside the old 3-parameter version rather than replacing it, so
-- the old signature is dropped explicitly first.
-- ─────────────────────────────────────────
drop function if exists public.accept_barter_offer(uuid, uuid, text);

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

-- ─────────────────────────────────────────
-- mark_barter_progress -- one flexible RPC for accepted -> preparing ->
-- (in_transit ->) awaiting_confirmation, gated by financial readiness
-- and delivery_method. Either party may call it.
-- ─────────────────────────────────────────
create or replace function public.mark_barter_progress(
  p_actor_user_id uuid,
  p_agreement_id uuid,
  p_target_status barter_status,
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
  v_offer record;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_actor_user_id is null then
    raise exception 'not authenticated';
  end if;

  v_request_hash := md5(coalesce(p_agreement_id::text, '') || '|' || coalesce(p_target_status::text, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_actor_user_id and operation = 'mark_barter_progress' and idempotency_key = p_idempotency_key;

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
  if v_agreement.status = 'disputed' then
    raise exception 'this agreement is currently disputed and cannot progress until it is resolved';
  end if;

  select * into v_offer from public.barter_offers where id = v_agreement.accepted_offer_id;

  if v_agreement.status = 'accepted' and p_target_status = 'preparing' then
    if v_offer.deposit_required and v_offer.deposit_payer in ('party_a', 'both') and not exists (
      select 1 from public.payments
      where barter_agreement_id = p_agreement_id and payment_type = 'barter_deposit'
        and renter_id = v_agreement.party_a_id and status in ('authorised', 'captured', 'released')
    ) then
      raise exception 'this agreement is not yet financially ready to proceed';
    end if;
    if v_offer.deposit_required and v_offer.deposit_payer in ('party_b', 'both') and not exists (
      select 1 from public.payments
      where barter_agreement_id = p_agreement_id and payment_type = 'barter_deposit'
        and renter_id = v_agreement.party_b_id and status in ('authorised', 'captured', 'released')
    ) then
      raise exception 'this agreement is not yet financially ready to proceed';
    end if;
    if v_offer.cash_adjustment_amount > 0 and not exists (
      select 1 from public.payments
      where barter_agreement_id = p_agreement_id and payment_type = 'barter_cash_adjustment' and status = 'captured'
    ) then
      raise exception 'this agreement is not yet financially ready to proceed';
    end if;
  elsif v_agreement.status = 'preparing' and p_target_status = 'in_transit' then
    if v_offer.delivery_method <> 'courier' then
      raise exception 'this delivery method does not use an in-transit step';
    end if;
  elsif v_agreement.status = 'preparing' and p_target_status = 'awaiting_confirmation' then
    if v_offer.delivery_method = 'courier' then
      raise exception 'this delivery method requires marking the item in transit first';
    end if;
  elsif v_agreement.status = 'in_transit' and p_target_status = 'awaiting_confirmation' then
    null;
  else
    raise exception 'this transition is not allowed from the agreement''s current status';
  end if;

  update public.barter_agreements set status = p_target_status, updated_at = now() where id = p_agreement_id;

  insert into public.barter_history (agreement_id, actor_user_id, actor_role, event_type, previous_status, new_status, idempotency_key)
  values (
    p_agreement_id, p_actor_user_id,
    case when p_actor_user_id = v_agreement.party_a_id then 'party_a' else 'party_b' end,
    'barter_progress_marked', v_agreement.status, p_target_status, p_idempotency_key
  );

  v_result := jsonb_build_object('agreement_id', p_agreement_id, 'status', p_target_status);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_actor_user_id, 'mark_barter_progress', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

-- ─────────────────────────────────────────
-- confirm_barter_completion -- dual-confirmation via barter_confirmations
-- (already exists since Phase A, never written to until now). No
-- automatic completion from one side.
-- ─────────────────────────────────────────
create or replace function public.confirm_barter_completion(
  p_actor_user_id uuid,
  p_agreement_id uuid,
  p_confirmation_note text default null,
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
  v_confirmation_count int;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_actor_user_id is null then
    raise exception 'not authenticated';
  end if;

  v_request_hash := md5(coalesce(p_agreement_id::text, '') || '|' || coalesce(p_confirmation_note, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_actor_user_id and operation = 'confirm_barter_completion' and idempotency_key = p_idempotency_key;

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
  if v_agreement.status = 'disputed' then
    raise exception 'this agreement is currently disputed and cannot be completed until it is resolved';
  end if;
  if v_agreement.status <> 'awaiting_confirmation' then
    raise exception 'this agreement is not yet awaiting completion confirmation';
  end if;

  insert into public.barter_confirmations (agreement_id, party_id, confirmation_note)
  values (p_agreement_id, p_actor_user_id, p_confirmation_note)
  on conflict (agreement_id, party_id) do nothing;

  select count(*) into v_confirmation_count from public.barter_confirmations where agreement_id = p_agreement_id;

  insert into public.barter_history (agreement_id, actor_user_id, actor_role, event_type, previous_status, new_status, metadata, idempotency_key)
  values (
    p_agreement_id, p_actor_user_id,
    case when p_actor_user_id = v_agreement.party_a_id then 'party_a' else 'party_b' end,
    'barter_completion_confirmed', v_agreement.status, v_agreement.status,
    jsonb_build_object('confirmations_count', v_confirmation_count), p_idempotency_key
  );

  if v_confirmation_count >= 2 then
    update public.barter_agreements set status = 'completed', completed_at = now() where id = p_agreement_id;

    insert into public.barter_history (agreement_id, actor_user_id, actor_role, event_type, previous_status, new_status)
    values (p_agreement_id, null, 'system', 'barter_completed', 'awaiting_confirmation', 'completed');

    v_result := jsonb_build_object('agreement_id', p_agreement_id, 'status', 'completed', 'confirmations_count', v_confirmation_count);
  else
    v_result := jsonb_build_object('agreement_id', p_agreement_id, 'status', 'awaiting_confirmation', 'confirmations_count', v_confirmation_count);
  end if;

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_actor_user_id, 'confirm_barter_completion', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

-- ─────────────────────────────────────────
-- admin_set_barter_hold -- suspend (p_hold=true) / reopen (p_hold=false),
-- same admin_hold/admin_hold_reason columns already on the table since
-- Phase A, previously unset by anything.
-- ─────────────────────────────────────────
create or replace function public.admin_set_barter_hold(
  p_admin_id uuid,
  p_agreement_id uuid,
  p_hold boolean,
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
  v_agreement record;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_admin_id is null then
    raise exception 'not authenticated';
  end if;

  v_request_hash := md5(coalesce(p_agreement_id::text, '') || '|' || coalesce(p_hold::text, '') || '|' || coalesce(p_reason, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_admin_id and operation = 'admin_set_barter_hold' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select * into v_agreement from public.barter_agreements where id = p_agreement_id for update;

  if v_agreement.id is null then
    raise exception 'barter agreement not found';
  end if;

  update public.barter_agreements
  set admin_hold = p_hold, admin_hold_reason = case when p_hold then p_reason else null end
  where id = p_agreement_id;

  insert into public.barter_history (agreement_id, actor_user_id, actor_role, event_type, previous_status, new_status, metadata, idempotency_key)
  values (
    p_agreement_id, p_admin_id, 'admin',
    case when p_hold then 'barter_admin_hold_set' else 'barter_admin_hold_released' end,
    v_agreement.status, v_agreement.status, jsonb_build_object('reason', p_reason), p_idempotency_key
  );

  v_result := jsonb_build_object('agreement_id', p_agreement_id, 'admin_hold', p_hold);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_admin_id, 'admin_set_barter_hold', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

-- ─────────────────────────────────────────
-- admin_cancel_barter_agreement -- admin-privileged sibling of
-- cancel_barter_agreement. Unlike the participant-facing RPC, this MAY
-- cancel a disputed agreement (an admin resolving a dispute needs this;
-- a participant bypassing the freeze does not).
-- ─────────────────────────────────────────
create or replace function public.admin_cancel_barter_agreement(
  p_admin_id uuid,
  p_agreement_id uuid,
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
  v_agreement record;
  v_settlement text;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_admin_id is null then
    raise exception 'not authenticated';
  end if;

  v_request_hash := md5(coalesce(p_agreement_id::text, '') || '|' || coalesce(p_reason, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_admin_id and operation = 'admin_cancel_barter_agreement' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select * into v_agreement from public.barter_agreements where id = p_agreement_id for update;

  if v_agreement.id is null then
    raise exception 'barter agreement not found';
  end if;
  if v_agreement.status in ('completed', 'cancelled', 'rejected', 'expired') then
    raise exception 'this agreement cannot be cancelled in its current status';
  end if;

  v_settlement := case
    when v_agreement.status in ('proposed', 'countered') then 'not_applicable'
    when v_agreement.status in ('accepted', 'preparing') then 'refunded'
    else 'frozen_pending_dispute' -- in_transit, awaiting_confirmation, disputed
  end;

  update public.barter_agreements set
    status = 'cancelled',
    cancelled_at = now(),
    cancelled_by = p_admin_id,
    cancellation_reason = p_reason,
    cancellation_settlement = v_settlement
  where id = p_agreement_id;

  insert into public.barter_history (agreement_id, actor_user_id, actor_role, event_type, previous_status, new_status, metadata, idempotency_key)
  values (
    p_agreement_id, p_admin_id, 'admin',
    'barter_admin_cancelled', v_agreement.status, 'cancelled',
    jsonb_build_object('cancellation_reason', p_reason, 'settlement', v_settlement), p_idempotency_key
  );

  v_result := jsonb_build_object('agreement_id', p_agreement_id, 'status', 'cancelled', 'settlement', v_settlement);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_admin_id, 'admin_cancel_barter_agreement', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

-- ─────────────────────────────────────────
-- Grants -- service_role only, matching every existing barter RPC.
-- ─────────────────────────────────────────
revoke all on function public.create_barter_payment_intent(uuid, uuid, uuid, payment_type, numeric, text, text) from public, anon, authenticated;
grant execute on function public.create_barter_payment_intent(uuid, uuid, uuid, payment_type, numeric, text, text) to service_role;

revoke all on function public.accept_barter_offer(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.accept_barter_offer(uuid, uuid, text, text) to service_role;

revoke all on function public.mark_barter_progress(uuid, uuid, barter_status, text) from public, anon, authenticated;
grant execute on function public.mark_barter_progress(uuid, uuid, barter_status, text) to service_role;

revoke all on function public.confirm_barter_completion(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.confirm_barter_completion(uuid, uuid, text, text) to service_role;

revoke all on function public.admin_set_barter_hold(uuid, uuid, boolean, text, text) from public, anon, authenticated;
grant execute on function public.admin_set_barter_hold(uuid, uuid, boolean, text, text) to service_role;

revoke all on function public.admin_cancel_barter_agreement(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.admin_cancel_barter_agreement(uuid, uuid, text, text) to service_role;
