-- ============================================================
-- E28-R1 -- Make booking dispute resolution + financial disposition atomic
-- ============================================================
-- E28 (20261108180657) closed the missing-financial-authority gap but
-- introduced a new, narrower one: the admin resolve route called
-- resolve_dispute() and then, across a separate network round trip,
-- record_dispute_financial_disposition(). If the first RPC succeeded
-- and the second failed (or the client simply never reached the
-- second call), the durable result was: dispute = resolved, booking
-- restored to 'completed', and NO disposition row -- a smaller-window
-- reincarnation of the exact race E28 was built to close, since the
-- booking payout gates' new check only fires when a disposition row
-- genuinely exists and is pending (deliberately, to avoid retroactive
-- interference with the 78 pre-existing historical disputes -- see
-- E28's own header. That design choice is correct and unchanged; it
-- just means the two-RPC sequence could recreate the exact
-- intermediate state the check was built to never need to ignore).
--
-- Fix: one new, booking-only, atomic RPC --
-- resolve_booking_dispute() -- that performs validation, the refund
-- authorization (if any), the disposition insert, the dispute
-- resolution, both history writes, and the booking restoration all
-- inside the SAME PL/pgSQL function body. A PL/pgSQL function call
-- has no internal transaction boundary of its own -- it runs inside
-- whatever transaction the caller (here, service_role's single RPC
-- call) is already in, and an unhandled RAISE EXCEPTION anywhere in
-- the body aborts that entire transaction, undoing every write the
-- function made up to that point. This function deliberately
-- contains no BEGIN/EXCEPTION/END block anywhere in its body (a
-- dedicated contract test proves this), because an exception handler
-- is exactly the mechanism that could otherwise swallow a failure and
-- let an earlier write in the same call survive it -- the one thing
-- this migration exists to make impossible. There is no multi-
-- statement client-visible intermediate state: the resolve route now
-- makes exactly one RPC call for a booking dispute, and that call
-- either fully commits every durable effect or none of them.
--
-- Domain boundary preserved exactly as E28 intended: resolve_dispute()
-- continues to serve orders/barter/RTB entirely unchanged. A new
-- guard is added to it (one `if` block, nothing else touched) that
-- explicitly REJECTS a booking dispute, forcing every booking
-- resolution through resolve_booking_dispute() -- closing the one
-- residual bypass this migration's own audit found: nothing
-- previously stopped resolve_dispute() from still being called
-- directly against a booking dispute, skipping the disposition
-- requirement entirely. This is the one and only change to
-- resolve_dispute()'s own body; its outcome/booking-restore/RTB
-- logic is reproduced byte-for-byte below it.
--
-- record_dispute_financial_disposition() (E28) is dropped outright,
-- not merely left uncalled: it has zero real callers after this
-- migration (the only one, the old two-RPC resolve route, is removed
-- in the same commit), and leaving a working, service-role-reachable
-- function that can independently insert a 'pending' disposition for
-- an ALREADY-resolved dispute -- including, in principle, any of the
-- 78 historical ones -- is exactly the kind of second operational
-- path the brief this migration implements explicitly warns against.
-- complete_dispute_financial_disposition() is NOT touched -- it
-- remains the correct, separate, later admin action for moving an
-- already-created disposition from pending to completed, exactly as
-- E28 designed it.
--
-- New escrow fail-closed guard (did not exist in E28): refund_required
-- is now rejected outright if the booking has ANY escrow_transactions
-- row (any status, mirroring E26's own has-any-escrow existence
-- check) -- a funded-or-released escrow row is a custody state this
-- migration does not attempt to reconcile with a payment-level
-- refund, and creating one without resolving escrow custody first
-- risks a merchant receiving an escrow release while the same
-- booking's renter is separately owed a refund. Of the 78 historical
-- disputes, only 2 ever had any escrow row (both already released) --
-- booking disputes are overwhelmingly a payments-only concern, so this
-- has negligible practical cost today while closing a real latent
-- risk. manual_financial_settlement is unaffected by this guard -- it
-- never calls create_refund() or touches payments/escrow at all; it
-- is a pure audit record of an externally-settled amount.
--
-- resolve_booking_dispute() does not accept a payment_id parameter --
-- it derives the booking's own rental_charge payment internally,
-- exactly as record_dispute_financial_disposition() did in E28 --
-- narrower surface, nothing for a caller to get wrong.
--
-- search_path = public (not ''): this function is a direct, booking-
-- scoped sibling of resolve_dispute() and reuses several of its own
-- enum casts (::booking_status) unqualified, exactly as resolve_
-- dispute() already does under the same setting -- matching that
-- established, already-reviewed convention for a function this
-- tightly coupled to it is safer than introducing a second
-- qualification style for the one new function in this file.
-- ============================================================

-- ── resolve_dispute(): one added guard, nothing else touched ──
-- Reproduced byte-for-byte from the current authoritative body
-- (20260904000003_dispute_resolve_restore_booking_all_outcomes.sql)
-- except for the new booking-rejection check immediately below the
-- existing not-found check.
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

  select id, status, booking_id, rent_to_buy_agreement_id, pre_dispute_status into v_dispute from public.disputes where id = p_dispute_id for update;
  if v_dispute.id is null then
    raise exception 'dispute not found';
  end if;

  -- E28-R1: a booking dispute must be resolved through
  -- resolve_booking_dispute() -- the only path that atomically
  -- requires and records a financial disposition in the same
  -- transaction. This is the one change in this function.
  if v_dispute.booking_id is not null then
    raise exception 'booking disputes must be resolved via resolve_booking_dispute';
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

  if v_dispute.rent_to_buy_agreement_id is not null and v_dispute.pre_dispute_status is not null and p_outcome = 'favor_respondent' then
    update public.rent_to_buy_agreements
    set status = v_dispute.pre_dispute_status::rent_to_buy_agreement_status
    where id = v_dispute.rent_to_buy_agreement_id and status = 'disputed';

    if found then
      v_restored := true;
      perform public._rent_to_buy_history(
        v_dispute.rent_to_buy_agreement_id, 'admin', p_admin_id, 'dispute_resolution_restored_status',
        'disputed', v_dispute.pre_dispute_status, jsonb_build_object('dispute_id', p_dispute_id, 'outcome', p_outcome)
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
-- CREATE OR REPLACE preserves the existing grants (service_role only).

-- ── resolve_booking_dispute(): the new atomic authority ─────
create or replace function public.resolve_booking_dispute(
  p_admin_id uuid,
  p_dispute_id uuid,
  p_outcome text,
  p_resolution_notes text default null,
  p_disposition_type text default null,
  p_disposition_amount numeric default null,
  p_disposition_reason text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dispute record;
  v_payment record;
  v_request_hash text;
  v_idem record;
  v_restored boolean := false;
  v_refund_id uuid;
  v_disposition_id uuid;
  v_disposition_status text;
  v_completed_by uuid;
  v_completed_at timestamptz;
  v_result jsonb;
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
  if p_disposition_type not in ('no_financial_adjustment', 'refund_required', 'manual_financial_settlement') then
    raise exception 'invalid disposition type';
  end if;
  if p_disposition_reason is null or length(trim(p_disposition_reason)) = 0 then
    raise exception 'a reason is required';
  end if;
  if p_disposition_type = 'no_financial_adjustment' and p_disposition_amount is not null then
    raise exception 'no_financial_adjustment must not carry an amount';
  end if;
  if p_disposition_type in ('refund_required', 'manual_financial_settlement') and (p_disposition_amount is null or p_disposition_amount <= 0) then
    raise exception 'a positive amount is required for this disposition type';
  end if;

  v_request_hash := md5(
    coalesce(p_dispute_id::text, '') || '|' || coalesce(p_outcome, '') || '|' || coalesce(p_resolution_notes, '') || '|' ||
    coalesce(p_disposition_type, '') || '|' || coalesce(p_disposition_amount::text, '') || '|' || coalesce(p_disposition_reason, '')
  );

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_admin_id and operation = 'resolve_booking_dispute' and idempotency_key = p_idempotency_key;

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
  if v_dispute.booking_id is null then
    raise exception 'resolve_booking_dispute is only for booking disputes';
  end if;
  if v_dispute.status <> 'under_review' then
    raise exception 'a dispute can only be resolved while under review';
  end if;
  if exists (select 1 from public.dispute_financial_dispositions where dispute_id = p_dispute_id) then
    raise exception 'a financial disposition has already been recorded for this dispute';
  end if;

  if p_disposition_type = 'refund_required' then
    -- E28-R1: fail closed rather than create a payment-level refund
    -- the system cannot prove is consistent with this booking's
    -- escrow custody state. See this migration's own header.
    if exists (select 1 from public.escrow_transactions where booking_id = v_dispute.booking_id) then
      raise exception 'this booking has escrow activity and cannot be refunded through this path -- reconcile escrow custody separately first';
    end if;

    select id, amount, status into v_payment
    from public.payments
    where booking_id = v_dispute.booking_id and payment_type = 'rental_charge'
    for update;
    if v_payment.id is null then
      raise exception 'no rental charge payment exists for this booking to refund';
    end if;
    if v_payment.status not in ('captured', 'partially_captured', 'partially_refunded') then
      raise exception 'the booking payment is not in a refundable status';
    end if;
    -- Reuses create_refund() itself -- never a second, independent
    -- cumulative-refund-cap formula.
    select (public.create_refund(v_payment.id, p_disposition_amount, p_disposition_reason, null)->>'refund_id')::uuid into v_refund_id;
  end if;

  if p_disposition_type = 'no_financial_adjustment' then
    v_disposition_status := 'completed';
    v_completed_by := p_admin_id;
    v_completed_at := now();
  else
    v_disposition_status := 'pending';
    v_completed_by := null;
    v_completed_at := null;
  end if;

  insert into public.dispute_financial_dispositions (
    dispute_id, disposition_type, amount, refund_id, status, reason, created_by, completed_by, completed_at
  ) values (
    p_dispute_id, p_disposition_type, p_disposition_amount, v_refund_id, v_disposition_status, p_disposition_reason, p_admin_id, v_completed_by, v_completed_at
  )
  returning id into v_disposition_id;

  update public.disputes set
    status = 'resolved',
    outcome = p_outcome,
    resolution_notes = p_resolution_notes,
    resolved_by = p_admin_id,
    resolved_at = now()
  where id = p_dispute_id;

  insert into public.dispute_history (dispute_id, actor_user_id, actor_role, event_type, previous_status, new_status, metadata, idempotency_key)
  values (p_dispute_id, p_admin_id, 'admin', 'dispute_resolved', 'under_review', 'resolved', jsonb_build_object('outcome', p_outcome), p_idempotency_key);

  insert into public.dispute_history (dispute_id, actor_user_id, actor_role, event_type, previous_status, new_status, metadata, idempotency_key)
  values (
    p_dispute_id, p_admin_id, 'admin', 'financial_disposition_recorded', null, v_disposition_status,
    jsonb_build_object('disposition_type', p_disposition_type, 'amount', p_disposition_amount, 'refund_id', v_refund_id), p_idempotency_key
  );

  if v_dispute.pre_dispute_status is not null then
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

  v_result := jsonb_build_object(
    'dispute_id', p_dispute_id, 'status', 'resolved', 'outcome', p_outcome, 'booking_status_restored', v_restored,
    'disposition_id', v_disposition_id, 'disposition_type', p_disposition_type, 'disposition_status', v_disposition_status, 'refund_id', v_refund_id
  );

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_admin_id, 'resolve_booking_dispute', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;
revoke all on function public.resolve_booking_dispute(uuid, uuid, text, text, text, numeric, text, text) from public, anon, authenticated;
grant execute on function public.resolve_booking_dispute(uuid, uuid, text, text, text, numeric, text, text) to service_role;

-- ── record_dispute_financial_disposition(): dropped, superseded ──
-- Zero real callers remain after this migration (the old two-RPC
-- resolve route is removed in the same commit) -- dropped outright
-- rather than left reachable, closing the one residual path that
-- could otherwise insert a 'pending' disposition for an ALREADY-
-- resolved dispute (including, in principle, any of the 78 historical
-- ones) completely independently of dispute resolution itself.
drop function if exists public.record_dispute_financial_disposition(uuid, uuid, text, numeric, text, text);
