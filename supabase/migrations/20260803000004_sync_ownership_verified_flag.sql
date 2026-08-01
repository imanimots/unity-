-- ============================================================
-- Sync listings.ownership_verified from decide_ownership_verification
-- ============================================================
-- Found live during Scenario A validation: the pre-existing
-- `listings.ownership_verified` boolean (used by the public listing
-- card/detail page to show a "Verified" badge -- src/types/index.ts,
-- marketing listing components) was never updated by the new ownership
-- verification RPCs. A listing could reach `status='verified'` in
-- listing_ownership_verification and even go 'active' while its public
-- badge still showed unverified. Fixed via CREATE OR REPLACE on the
-- just-applied function, per this codebase's forward-only convention --
-- not editing 20260803000003.
--
-- Safe under protect_listing_privileged_fields(): that trigger only
-- reverts ownership_verified for non-service_role callers, and this RPC
-- is itself service_role-only (auth.role() = 'service_role' for the
-- duration of the call), so the UPDATE below passes through unmodified.
-- Only 'verified' sets the flag true -- 'rejected' and
-- 'additional_evidence_required' leave it at its existing value (already
-- false for a listing that was never verified; deliberately not reset to
-- false here for the (currently unreachable, since verified/rejected are
-- both terminal per this RPC's own guard) case of re-deciding an already
-- verified listing, which is out of scope for this fix).
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

create or replace function public.decide_ownership_verification(
  p_listing_id uuid,
  p_admin_id uuid,
  p_decision text,
  p_reason_code text,
  p_reviewer_notes text,
  p_merchant_feedback text,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_operation text;
  v_request_hash text;
  v_idem record;
  v_existing_status ownership_verification_status;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_admin_id is null then
    raise exception 'not authenticated';
  end if;
  if p_decision not in ('verified', 'rejected', 'additional_evidence_required') then
    raise exception 'invalid ownership decision';
  end if;
  if not exists (select 1 from public.listings where id = p_listing_id) then
    raise exception 'listing not found';
  end if;

  v_operation := 'decide_ownership_verification:' || p_decision;
  v_request_hash := md5(
    coalesce(p_listing_id::text, '') || '|' || coalesce(p_reason_code, '') || '|' ||
    coalesce(p_reviewer_notes, '') || '|' || coalesce(p_merchant_feedback, '')
  );

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_admin_id and operation = v_operation and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select status into v_existing_status
  from public.listing_ownership_verification where listing_id = p_listing_id;

  if v_existing_status in ('verified', 'rejected') then
    raise exception 'ownership verification already has a final decision';
  end if;

  insert into public.listing_ownership_verification (
    listing_id, status, provider, reason_code, reviewer_notes, merchant_feedback, reviewed_by, reviewed_at
  ) values (
    p_listing_id, p_decision::ownership_verification_status, 'manual', p_reason_code, p_reviewer_notes, p_merchant_feedback, p_admin_id, v_now
  )
  on conflict (listing_id) do update set
    status = p_decision::ownership_verification_status,
    reason_code = p_reason_code,
    reviewer_notes = p_reviewer_notes,
    merchant_feedback = p_merchant_feedback,
    reviewed_by = p_admin_id,
    reviewed_at = v_now,
    updated_at = v_now;

  -- The fix: keep the pre-existing public-facing flag in sync.
  if p_decision = 'verified' then
    update public.listings set ownership_verified = true where id = p_listing_id;
  end if;

  insert into public.listing_history (listing_id, changed_by, old_values, new_values, change_reason)
  values (
    p_listing_id, p_admin_id,
    jsonb_build_object('ownership_verification_status', coalesce(v_existing_status::text, 'none')),
    jsonb_build_object('ownership_verification_status', p_decision, 'merchant_feedback', p_merchant_feedback),
    'ownership_verification_' || p_decision
  );

  insert into public.admin_action_history (
    listing_id, action_type, admin_id, reason_code, internal_note, merchant_feedback, previous_status, new_status
  ) values (
    p_listing_id, 'ownership_verification_' || p_decision, p_admin_id, p_reason_code, p_reviewer_notes, p_merchant_feedback,
    coalesce(v_existing_status::text, 'none'), p_decision
  );

  v_result := jsonb_build_object('listing_id', p_listing_id, 'ownership_verification_status', p_decision);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_admin_id, v_operation, p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

revoke all on function public.decide_ownership_verification(uuid, uuid, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.decide_ownership_verification(uuid, uuid, text, text, text, text, text) to service_role;
