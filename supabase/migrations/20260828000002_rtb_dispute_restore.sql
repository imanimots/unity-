-- ============================================================
-- Phase 5 corrective -- Rent-to-Buy: dispute-resolution status
-- restoration.
-- ============================================================
-- Bug: open_dispute()'s RTB branch (20260827000004) already captures
-- disputes.pre_dispute_status for an RTB agreement (mirroring booking/
-- order/barter identically) and sets rent_to_buy_agreements.status =
-- 'disputed' -- but resolve_dispute()/cancel_dispute() never read that
-- column back for the rent_to_buy_agreement_id branch, only for
-- booking_id. A resolved/cancelled RTB dispute permanently stranded the
-- agreement at 'disputed' with no path back to normal operation. RTB is
-- a new feature and must not ship with this lifecycle bug (unlike
-- order/barter's own pre-existing, separately-tracked version of the
-- same gap, which this migration deliberately does NOT touch -- out of
-- scope, not broadened here).
--
-- Same outcome-specific policy as booking's own precedent
-- (20260824000002_dispute_resolve_restore_favor_respondent_only.sql),
-- reasoned identically for RTB:
--   - resolve_dispute(): restores rent_to_buy_agreements.status to its
--     pre_dispute_status ONLY when p_outcome = 'favor_respondent' -- the
--     one outcome that unambiguously means the party the dispute was
--     raised against was vindicated and normal continuation is safe.
--     favor_raiser / mutual_agreement / manual_settlement all leave the
--     agreement at 'disputed' -- an explicit, honest,
--     manual-resolution-required state -- because this schema has no
--     structured signal for what financial/possession consequence those
--     outcomes imply (Rule 7/16 -- exactly the "REQUIRES BUSINESS
--     APPROVAL" territory this whole phase must never fabricate into).
--   - cancel_dispute(): restores unconditionally, matching booking's own
--     reasoning verbatim -- a cancelled dispute was withdrawn/dismissed
--     before any ruling at all, so there is no outcome to be cautious
--     about.
--
-- Neither function fabricates payment, ownership, or completion:
-- restoration only ever writes back rent_to_buy_agreements.status to
-- whatever it verifiably already was immediately before the dispute
-- opened (captured once, at open_dispute() time) -- never a new value,
-- never ownership_status, never an installment status.
--
-- CREATE OR REPLACE, same signatures as the current authoritative
-- versions (20260824000002 / 20260824000001) -- both already handle
-- booking_id; this adds a parallel rent_to_buy_agreement_id branch,
-- byte-identical in every other line.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

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

  if v_dispute.booking_id is not null and v_dispute.pre_dispute_status is not null and p_outcome = 'favor_respondent' then
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

revoke all on function public.resolve_dispute(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.resolve_dispute(uuid, uuid, text, text, text) to service_role;

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

  select id, status, booking_id, rent_to_buy_agreement_id, pre_dispute_status into v_dispute from public.disputes where id = p_dispute_id for update;
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

  if v_dispute.rent_to_buy_agreement_id is not null and v_dispute.pre_dispute_status is not null then
    update public.rent_to_buy_agreements
    set status = v_dispute.pre_dispute_status::rent_to_buy_agreement_status
    where id = v_dispute.rent_to_buy_agreement_id and status = 'disputed';

    if found then
      v_restored := true;
      perform public._rent_to_buy_history(
        v_dispute.rent_to_buy_agreement_id, 'admin', p_admin_id, 'dispute_cancellation_restored_status',
        'disputed', v_dispute.pre_dispute_status, jsonb_build_object('dispute_id', p_dispute_id, 'reason', p_cancellation_reason)
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
