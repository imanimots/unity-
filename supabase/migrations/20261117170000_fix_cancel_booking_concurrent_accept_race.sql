-- E49.1 Phase D (concurrency verification): cancel_booking took no row lock
-- and its closing UPDATE had no status precondition in its own WHERE
-- clause -- unlike accept_booking_request (which takes `for update`) and
-- unlike merchant_pause_listing/merchant_resume_listing (already fixed for
-- the identical bug class by 20260904000002). A renter's cancel_booking
-- and the merchant's accept_booking_request could interleave: if cancel's
-- initial read happened before accept's lock+commit, cancel's blind
-- UPDATE could silently overwrite an already-'accepted' booking back to
-- 'cancelled_by_renter'/'cancelled_by_merchant' with no re-check and no
-- error -- clobbering the other party's action instead of being rejected.
--
-- Minimal fix, same pattern as 20260904000002: add the read status as an
-- explicit precondition on the UPDATE's own WHERE clause and gate the
-- history insert + result on the UPDATE actually having affected a row
-- (GET DIAGNOSTICS ... ROW_COUNT). The race-loser's UPDATE blocks on the
-- winner's row lock, re-evaluates its WHERE clause against the
-- now-committed row, affects 0 rows, and raises the same existing domain
-- error the initial status check already raises for a wrong-state
-- booking -- no new error text, no client-visible behavior change,
-- already mapped by mapBookingRpcError(). Signature is unchanged, so a
-- bare CREATE OR REPLACE is sufficient.
create or replace function public.cancel_booking(
  p_actor_user_id uuid,
  p_booking_id uuid,
  p_cancellation_reason text default null,
  p_idempotency_key text default null
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
  v_new_status booking_status;
  v_notice_hours int;
  v_result jsonb;
  v_rows int;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_actor_user_id is null then
    raise exception 'not authenticated';
  end if;

  v_request_hash := md5(coalesce(p_booking_id::text, '') || '|' || coalesce(p_cancellation_reason, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_actor_user_id and operation = 'cancel_booking' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select id, renter_id, merchant_id, status, start_at, terms_snapshot
  into v_booking
  from public.bookings
  where id = p_booking_id and (renter_id = p_actor_user_id or merchant_id = p_actor_user_id);

  if v_booking.id is null then
    raise exception 'booking not found or you are not a party to it';
  end if;

  if v_booking.renter_id = p_actor_user_id then
    if v_booking.status = 'requested' then
      v_new_status := 'cancelled_by_renter';
    elsif v_booking.status = 'accepted' then
      v_notice_hours := (v_booking.terms_snapshot->>'renter_cancellation_notice_hours')::int;
      if v_notice_hours is not null and now() > v_booking.start_at - make_interval(hours => v_notice_hours) then
        raise exception 'the cancellation notice period for this booking has passed';
      end if;
      v_new_status := 'cancelled_by_renter';
    else
      raise exception 'booking cannot be cancelled in its current status';
    end if;
  else
    if v_booking.status = 'requested' then
      raise exception 'use reject for a requested booking, not cancel';
    elsif v_booking.status = 'accepted' then
      v_notice_hours := (v_booking.terms_snapshot->>'merchant_cancellation_notice_hours')::int;
      if v_notice_hours is not null and now() > v_booking.start_at - make_interval(hours => v_notice_hours) then
        raise exception 'the cancellation notice period for this booking has passed';
      end if;
      v_new_status := 'cancelled_by_merchant';
    elsif v_booking.status = 'active' then
      raise exception 'active bookings can only be cancelled through an administrative process';
    else
      raise exception 'booking cannot be cancelled in its current status';
    end if;
  end if;

  update public.bookings
  set status = v_new_status, cancelled_at = now(), cancelled_by = p_actor_user_id,
      cancellation_reason = p_cancellation_reason, version = version + 1
  where id = p_booking_id and status = v_booking.status;

  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'booking cannot be cancelled in its current status';
  end if;

  insert into public.booking_history (booking_id, actor_user_id, actor_role, event_type, previous_status, new_status, metadata)
  values (
    p_booking_id, p_actor_user_id,
    case when v_booking.renter_id = p_actor_user_id then 'renter' else 'merchant' end,
    'booking_cancelled', v_booking.status, v_new_status,
    jsonb_build_object('cancellation_reason', p_cancellation_reason, 'settlement_status', 'not_applicable_no_payment_collected')
  );

  v_result := jsonb_build_object('booking_id', p_booking_id, 'status', v_new_status, 'settlement_status', 'not_applicable_no_payment_collected');

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_actor_user_id, 'cancel_booking', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;
-- CREATE OR REPLACE preserves the existing grants (service_role only).
