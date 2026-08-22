-- Product decision (explicit, this phase): a resolved booking dispute must
-- not leave the booking permanently stuck at 'disputed' -- for ANY of the
-- four dispute outcomes, not only favor_respondent. Booking-status
-- restoration is now treated the same way for favor_raiser,
-- mutual_agreement, and manual_settlement as it already was for
-- favor_respondent (and matches cancel_dispute()'s existing unconditional
-- restore behavior). Any financial correction warranted by a
-- customer-favorable/mutual/manual outcome remains the responsibility of
-- the existing, separate create_refund() mechanism -- this migration does
-- not add, infer, or trigger any refund/settlement logic itself.
--
-- Only the booking-restoration condition changes (drops the
-- "and p_outcome = 'favor_respondent'" restriction). Everything else,
-- INCLUDING the rent_to_buy_agreement_id branch below it, is reproduced
-- byte-for-byte from the current live function
-- (supabase/migrations/20260828000002_rtb_dispute_restore.sql) and is left
-- untouched -- RTB V2's own favor_respondent-only restore rule (Rule 7/16,
-- a separate, already-closed decision) is out of scope for this task and
-- must not change here.
--
-- Same signature, CREATE OR REPLACE only (no DROP FUNCTION needed).

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
