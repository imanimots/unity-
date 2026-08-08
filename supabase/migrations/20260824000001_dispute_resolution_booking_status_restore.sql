-- ============================================================
-- Corrective maintenance: resolved-dispute booking.status bug.
--
-- ROOT CAUSE (confirmed live, Step B reproduction): open_dispute() sets
-- the referenced booking's status to 'disputed' but never records what
-- the booking's status was immediately before that -- and neither
-- resolve_dispute() nor cancel_dispute() ever restores it (documented
-- as a known, deliberate limitation in 20260814000006_dispute_rpcs.sql's
-- own header comment at the time -- "deciding what a transaction should
-- become after a resolved dispute depends on financial-outcome
-- execution that's out of scope here"). Because Phase 8's
-- mark_payout_processing (and createMerchantPayout's own reconciliation
-- sweep) requires booking.status = 'completed', a booking that is ever
-- disputed -- even if the dispute resolves cleanly in the merchant's
-- favor with zero refund -- has its payout permanently blocked, forever,
-- with no live path to recover.
--
-- FIX: add disputes.pre_dispute_status (nullable text -- the exact
-- prior booking_status/order_status/barter_status value, captured
-- generically for all three domains since open_dispute() already
-- branches on all three, at negligible extra cost). CREATE OR REPLACE
-- open_dispute() to populate it. CREATE OR REPLACE resolve_dispute()
-- and cancel_dispute() to restore bookings.status to that exact value
-- once the dispute reaches its terminal outcome -- scoped to bookings
-- only in this pass, per this corrective task's explicit title/scope
-- ("This task is ONLY to investigate and fix... booking dispute...
-- booking.status"). Orders/barter share the identical root cause and
-- the identical pre_dispute_status column is captured for them too, but
-- restoring order_status/barter_status is deliberately left for a
-- future, separately-scoped pass -- not touched here.
--
-- close_dispute() is NOT touched -- it only ever runs after
-- resolve_dispute() has already restored the booking (resolved ->
-- closed is a purely administrative dispute-side step), so there is
-- nothing left to restore at that point.
--
-- SAFETY / CORE INVARIANT: this does NOT touch payout eligibility logic
-- at all -- mark_payout_processing, createMerchantPayout, and every
-- other Phase 8 check (refund status, chargeback, account restriction,
-- one-payout-per-booking) are completely unmodified and remain exactly
-- as strict as before. This fix only unsticks booking.status back to
-- an accurate reflection of the transaction's real operational state;
-- whether a merchant is actually financially entitled continues to be
-- decided entirely by Phase 8's own existing, unchanged checks. No
-- outcome-based branching into a fabricated "cancelled"/"refunded"
-- booking state is added here -- outcome alone (favor_raiser/
-- favor_respondent/mutual_agreement/manual_settlement) does not
-- structurally establish that a refund actually happened (refunds are
-- a separate, already-existing mechanism via create_refund()), and
-- Phase 8's own refund-status check already correctly blocks payout
-- independent of booking.status whenever a real refund exists. A
-- dispute with no pre_dispute_status on record (a historical row from
-- before this migration) is left untouched, never guessed from
-- timestamps.
--
-- Restoration is idempotency-safe by construction: the UPDATE is
-- WHERE-guarded on bookings.status = 'disputed', so an exact-replay of
-- resolve_dispute()/cancel_dispute() (already short-circuited by the
-- existing idempotency_keys cache) or any other retry is a harmless
-- no-op if the booking has already been restored or changed since.
-- Every restoration writes one booking_history row (existing,
-- immutable, append-only table) -- actor_role='system' (booking_history
-- has no 'admin' value in its check constraint), actor_user_id is the
-- resolving/cancelling admin for real audit attribution.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

alter table public.disputes
  add column if not exists pre_dispute_status text;

comment on column public.disputes.pre_dispute_status is
  'The referenced transaction''s own status value (booking_status/order_status/barter_status as text) immediately before open_dispute() set it to disputed. Null for disputes opened before this column existed. Used by resolve_dispute()/cancel_dispute() to restore the transaction to its accurate pre-dispute state.';

-- ─────────────────────────────────────────
-- open_dispute -- CREATE OR REPLACE, same signature. Only change:
-- capture the referenced transaction's current status into
-- pre_dispute_status before overwriting it to 'disputed'.
-- ─────────────────────────────────────────
create or replace function public.open_dispute(
  p_raiser_user_id uuid,
  p_booking_id uuid default null,
  p_order_id uuid default null,
  p_barter_agreement_id uuid default null,
  p_title text default null,
  p_reason text default null,
  p_description text default null,
  p_requested_resolution text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dispute_id uuid;
  v_reference_count int;
  v_request_hash text;
  v_idem record;
  v_result jsonb;
  v_booking record;
  v_order record;
  v_agreement record;
  v_respondent_id uuid;
  v_pre_dispute_status text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_raiser_user_id is null then
    raise exception 'raiser is required';
  end if;
  if p_title is null or length(trim(p_title)) = 0 then
    raise exception 'title is required';
  end if;
  if p_description is null or length(trim(p_description)) = 0 then
    raise exception 'description is required';
  end if;
  if p_requested_resolution is null or length(trim(p_requested_resolution)) = 0 then
    raise exception 'requested resolution is required';
  end if;

  v_reference_count := (case when p_booking_id is not null then 1 else 0 end)
    + (case when p_order_id is not null then 1 else 0 end)
    + (case when p_barter_agreement_id is not null then 1 else 0 end);
  if v_reference_count <> 1 then
    raise exception 'exactly one of booking_id, order_id, or barter_agreement_id is required';
  end if;

  v_request_hash := md5(
    coalesce(p_booking_id::text, '') || '|' || coalesce(p_order_id::text, '') || '|' || coalesce(p_barter_agreement_id::text, '') || '|' ||
    coalesce(p_title, '') || '|' || coalesce(p_reason, '') || '|' || coalesce(p_description, '') || '|' || coalesce(p_requested_resolution, '')
  );

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_raiser_user_id and operation = 'open_dispute' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  if p_booking_id is not null then
    select id, renter_id, merchant_id, status::text into v_booking from public.bookings where id = p_booking_id for update;
    if v_booking.id is null then
      raise exception 'booking not found';
    end if;
    if v_booking.renter_id <> p_raiser_user_id and v_booking.merchant_id <> p_raiser_user_id then
      raise exception 'raiser is not a party to this booking';
    end if;
    v_respondent_id := case when v_booking.renter_id = p_raiser_user_id then v_booking.merchant_id else v_booking.renter_id end;
    if exists (select 1 from public.disputes where booking_id = p_booking_id and status not in ('resolved', 'closed', 'cancelled')) then
      raise exception 'a dispute is already open for this booking';
    end if;
    v_pre_dispute_status := v_booking.status;
    update public.bookings set status = 'disputed' where id = p_booking_id;
  elsif p_order_id is not null then
    select id, buyer_id, seller_id, status::text into v_order from public.orders where id = p_order_id for update;
    if v_order.id is null then
      raise exception 'order not found';
    end if;
    if v_order.buyer_id <> p_raiser_user_id and v_order.seller_id <> p_raiser_user_id then
      raise exception 'raiser is not a party to this order';
    end if;
    v_respondent_id := case when v_order.buyer_id = p_raiser_user_id then v_order.seller_id else v_order.buyer_id end;
    if exists (select 1 from public.disputes where order_id = p_order_id and status not in ('resolved', 'closed', 'cancelled')) then
      raise exception 'a dispute is already open for this order';
    end if;
    v_pre_dispute_status := v_order.status;
    update public.orders set status = 'disputed' where id = p_order_id;
  else
    select id, party_a_id, party_b_id, status::text into v_agreement from public.barter_agreements where id = p_barter_agreement_id for update;
    if v_agreement.id is null then
      raise exception 'barter agreement not found';
    end if;
    if v_agreement.party_a_id <> p_raiser_user_id and v_agreement.party_b_id <> p_raiser_user_id then
      raise exception 'raiser is not a party to this barter agreement';
    end if;
    v_respondent_id := case when v_agreement.party_a_id = p_raiser_user_id then v_agreement.party_b_id else v_agreement.party_a_id end;
    if exists (select 1 from public.disputes where barter_agreement_id = p_barter_agreement_id and status not in ('resolved', 'closed', 'cancelled')) then
      raise exception 'a dispute is already open for this barter agreement';
    end if;
    v_pre_dispute_status := v_agreement.status;
    update public.barter_agreements set status = 'disputed' where id = p_barter_agreement_id;
  end if;

  insert into public.disputes (
    booking_id, order_id, barter_agreement_id, raised_by, title, reason, description, requested_resolution, status, pre_dispute_status
  ) values (
    p_booking_id, p_order_id, p_barter_agreement_id, p_raiser_user_id, p_title, p_reason, p_description, p_requested_resolution, 'open', v_pre_dispute_status
  )
  returning id into v_dispute_id;

  insert into public.dispute_history (dispute_id, actor_user_id, actor_role, event_type, previous_status, new_status, idempotency_key)
  values (v_dispute_id, p_raiser_user_id, 'raiser', 'dispute_opened', null, 'open', p_idempotency_key);

  v_result := jsonb_build_object('dispute_id', v_dispute_id, 'status', 'open', 'respondent_id', v_respondent_id);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_raiser_user_id, 'open_dispute', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

revoke all on function public.open_dispute(uuid, uuid, uuid, uuid, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.open_dispute(uuid, uuid, uuid, uuid, text, text, text, text, text) to service_role;

-- ─────────────────────────────────────────
-- resolve_dispute -- CREATE OR REPLACE, same signature. Only change:
-- after the dispute itself transitions to 'resolved', if it references
-- a booking and a pre_dispute_status was recorded, restore
-- bookings.status to that value (WHERE-guarded on status='disputed' for
-- idempotency/safety) and write one booking_history row.
-- ─────────────────────────────────────────
create or replace function public.resolve_dispute(
  p_admin_id uuid,
  p_dispute_id uuid,
  p_outcome text,
  p_resolution_notes text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dispute record;
  v_request_hash text;
  v_idem record;
  v_result jsonb;
  v_restored boolean := false;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_admin_id is null then
    raise exception 'admin is required';
  end if;
  if p_outcome not in ('favor_raiser', 'favor_respondent', 'mutual_agreement', 'manual_settlement') then
    raise exception 'invalid outcome';
  end if;

  v_request_hash := md5(coalesce(p_dispute_id::text, '') || '|' || coalesce(p_outcome, '') || '|' || coalesce(p_resolution_notes, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_admin_id and operation = 'resolve_dispute' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select id, status, booking_id, pre_dispute_status into v_dispute from public.disputes where id = p_dispute_id for update;
  if v_dispute.id is null then
    raise exception 'dispute not found';
  end if;
  if v_dispute.status <> 'under_review' then
    raise exception 'a dispute can only be resolved while under review';
  end if;

  update public.disputes set
    status = 'resolved',
    outcome = p_outcome,
    resolution_notes = p_resolution_notes,
    resolved_by = p_admin_id,
    resolved_at = now()
  where id = p_dispute_id;

  insert into public.dispute_history (dispute_id, actor_user_id, actor_role, event_type, previous_status, new_status, metadata, idempotency_key)
  values (p_dispute_id, p_admin_id, 'admin', 'dispute_resolved', 'under_review', 'resolved', jsonb_build_object('outcome', p_outcome), p_idempotency_key);

  if v_dispute.booking_id is not null and v_dispute.pre_dispute_status is not null then
    update public.bookings
    set status = v_dispute.pre_dispute_status::booking_status, version = version + 1
    where id = v_dispute.booking_id and status = 'disputed';

    if found then
      v_restored := true;
      insert into public.booking_history (booking_id, actor_user_id, actor_role, event_type, previous_status, new_status, metadata)
      values (
        v_dispute.booking_id, p_admin_id, 'system', 'dispute_resolution_restored_status',
        'disputed'::booking_status, v_dispute.pre_dispute_status::booking_status,
        jsonb_build_object('dispute_id', p_dispute_id, 'outcome', p_outcome)
      );
    end if;
  end if;

  v_result := jsonb_build_object('dispute_id', p_dispute_id, 'status', 'resolved', 'outcome', p_outcome, 'booking_status_restored', v_restored);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_admin_id, 'resolve_dispute', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

revoke all on function public.resolve_dispute(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.resolve_dispute(uuid, uuid, text, text, text) to service_role;

-- ─────────────────────────────────────────
-- cancel_dispute -- CREATE OR REPLACE, same signature. Same restoration
-- logic as resolve_dispute -- a cancelled dispute (withdrawn/dismissed
-- without adjudication) equally frees the booking to resume its
-- accurate prior state.
-- ─────────────────────────────────────────
create or replace function public.cancel_dispute(
  p_admin_id uuid,
  p_dispute_id uuid,
  p_cancellation_reason text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dispute record;
  v_request_hash text;
  v_idem record;
  v_result jsonb;
  v_restored boolean := false;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_admin_id is null then
    raise exception 'admin is required';
  end if;

  v_request_hash := md5(coalesce(p_dispute_id::text, '') || '|' || coalesce(p_cancellation_reason, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_admin_id and operation = 'cancel_dispute' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select id, status, booking_id, pre_dispute_status into v_dispute from public.disputes where id = p_dispute_id for update;
  if v_dispute.id is null then
    raise exception 'dispute not found';
  end if;
  if v_dispute.status in ('resolved', 'closed', 'cancelled') then
    raise exception 'this dispute is no longer active';
  end if;

  update public.disputes set
    status = 'cancelled',
    cancelled_by = p_admin_id,
    cancelled_at = now(),
    cancellation_reason = p_cancellation_reason
  where id = p_dispute_id;

  insert into public.dispute_history (dispute_id, actor_user_id, actor_role, event_type, previous_status, new_status, metadata, idempotency_key)
  values (p_dispute_id, p_admin_id, 'admin', 'dispute_cancelled', v_dispute.status::text, 'cancelled', jsonb_build_object('reason', p_cancellation_reason), p_idempotency_key);

  if v_dispute.booking_id is not null and v_dispute.pre_dispute_status is not null then
    update public.bookings
    set status = v_dispute.pre_dispute_status::booking_status, version = version + 1
    where id = v_dispute.booking_id and status = 'disputed';

    if found then
      v_restored := true;
      insert into public.booking_history (booking_id, actor_user_id, actor_role, event_type, previous_status, new_status, metadata)
      values (
        v_dispute.booking_id, p_admin_id, 'system', 'dispute_cancellation_restored_status',
        'disputed'::booking_status, v_dispute.pre_dispute_status::booking_status,
        jsonb_build_object('dispute_id', p_dispute_id, 'reason', p_cancellation_reason)
      );
    end if;
  end if;

  v_result := jsonb_build_object('dispute_id', p_dispute_id, 'status', 'cancelled', 'booking_status_restored', v_restored);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_admin_id, 'cancel_dispute', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

revoke all on function public.cancel_dispute(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.cancel_dispute(uuid, uuid, text, text) to service_role;
