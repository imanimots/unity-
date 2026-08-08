-- ============================================================
-- Fix-forward correction to 20260824000001 (this session, applied minutes
-- earlier) -- found via live testing, not assumed:
--
-- The previous migration restored bookings.status on EVERY
-- resolve_dispute() outcome unconditionally. Live-tested against a
-- favor_raiser (customer-favorable) resolution with zero refund
-- processed: booking.status was restored to 'completed' and
-- mark_payout_processing then incorrectly succeeded (200, moved to
-- 'processing') -- exactly the "customer-favorable resolution
-- incorrectly restores payout eligibility" failure mode this corrective
-- task's own required regression coverage explicitly guards against.
--
-- FIX: resolve_dispute() now restores bookings.status only when
-- p_outcome = 'favor_respondent' -- the one outcome that unambiguously
-- means the respondent (typically the merchant) was vindicated and
-- normal continuation is warranted. For favor_raiser/mutual_agreement/
-- manual_settlement, bookings.status is left at 'disputed' -- not
-- fabricated into any other state, since the schema has no structured
-- signal for what should happen financially (a refund, if warranted, is
-- a separate, already-existing admin action via create_refund(), never
-- inferred from the outcome label alone). Leaving it at 'disputed'
-- keeps Phase 8's existing, unmodified eligibility check
-- (booking.status must be 'completed') correctly blocking payout --
-- no new blocking logic is added, the existing check simply continues
-- to apply because the booking is honestly left unrestored.
--
-- cancel_dispute() is NOT changed by this migration -- a cancelled
-- dispute has no outcome/adjudication at all (withdrawn or dismissed
-- before any ruling), so unconditional restoration there remains
-- correct and safe (Step C example D).
--
-- Never edit an already-applied migration -- this is a NEW migration,
-- mirroring this project's own established fix-forward precedent
-- (e.g. 20260823000007 correcting 20260823000003 within the same
-- session).
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
