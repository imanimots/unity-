-- ============================================================
-- Admin moderation + ownership verification RPCs (Step 3, public-test MVP)
-- ============================================================
-- Same trust model as submit_listing_for_review()
-- (20260730000002_restrict_submit_to_server.sql): every function here is
-- SECURITY DEFINER, refuses to run for anyone but service_role (defense
-- in depth even if the EXECUTE grant were ever misconfigured), takes the
-- acting admin's id as an explicit parameter (a service-role session has
-- no auth.uid()), and is self-contained -- idempotency check, state
-- validation, mutation, and listing_history write all happen in one
-- function call. The calling API route independently verifies the caller
-- is a real admin (requireAdmin()) before ever reaching these.
--
-- Idempotency reuses idempotency_keys exactly as established -- scoped by
-- the ADMIN's own profile id (the generic "scoping key" column, named
-- merchant_id for historical reasons but reused across domains since
-- Phase 2C), never by listing id (which is not a profiles.id and would
-- fail the table's hard FK, the exact bug fixed in
-- 20260801000005_payment_idempotency_fk_fix.sql). This also satisfies
-- "cross-admin replay cannot leak data": two different admins using the
-- same literal key string never collide, since each key is scoped to its
-- own admin's id.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

-- ─────────────────────────────────────────
-- Extend the existing privileged-fields trigger to also protect
-- 'suspended' -- CREATE OR REPLACE on an already-applied function, per
-- this codebase's established convention for RPC/trigger changes
-- (never editing a delivered migration file). Merchants may still set
-- 'draft'/'pending'/'paused' directly, exactly as before; only
-- 'active'/'rented'/'suspended' are blocked from non-service-role writes.
-- ─────────────────────────────────────────
create or replace function public.protect_listing_privileged_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then
    if TG_OP = 'INSERT' then
      new.ownership_verified := false;
      if new.status in ('active', 'rented', 'suspended') then
        new.status := 'draft';
      end if;
    else
      new.merchant_id := old.merchant_id;
      new.ownership_verified := old.ownership_verified;

      if new.status in ('active', 'rented', 'suspended') and new.status is distinct from old.status then
        new.status := old.status;
      end if;
    end if;
  end if;
  return new;
end;
$$;

-- ─────────────────────────────────────────
-- start_ownership_review — moves ownership verification into
-- 'under_review'. Upserts the row (a listing may not have one yet — see
-- 20260803000001's header comment). Allowed from any non-terminal state;
-- refuses to restart a review that's already reached a terminal verdict,
-- since that would silently discard the prior decision without going
-- through decide_ownership_verification's own audit trail.
-- ─────────────────────────────────────────
create or replace function public.start_ownership_review(
  p_listing_id uuid,
  p_admin_id uuid,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
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
  if not exists (select 1 from public.listings where id = p_listing_id) then
    raise exception 'listing not found';
  end if;

  v_request_hash := md5(coalesce(p_listing_id::text, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_admin_id and operation = 'start_ownership_review' and idempotency_key = p_idempotency_key;

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
    raise exception 'ownership verification already has a final decision and cannot be restarted';
  end if;

  insert into public.listing_ownership_verification (listing_id, status, provider)
  values (p_listing_id, 'under_review', 'manual')
  on conflict (listing_id) do update set status = 'under_review', updated_at = v_now;

  insert into public.listing_history (listing_id, changed_by, old_values, new_values, change_reason)
  values (
    p_listing_id, p_admin_id,
    jsonb_build_object('ownership_verification_status', coalesce(v_existing_status::text, 'none')),
    jsonb_build_object('ownership_verification_status', 'under_review'),
    'ownership_review_started'
  );

  insert into public.admin_action_history (listing_id, action_type, admin_id, previous_status, new_status)
  values (p_listing_id, 'ownership_review_started', p_admin_id, coalesce(v_existing_status::text, 'none'), 'under_review');

  v_result := jsonb_build_object('listing_id', p_listing_id, 'ownership_verification_status', 'under_review');

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_admin_id, 'start_ownership_review', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

-- ─────────────────────────────────────────
-- decide_ownership_verification — the one decision RPC covering all
-- three verdicts (verified / rejected / additional_evidence_required),
-- matching the OwnershipVerificationService's three named operations.
-- One function rather than three because the state-machine guard and
-- history write are identical for all three -- only the target status,
-- reason and idempotency operation name differ, and the operation name
-- (built from p_decision) already keeps each verdict's idempotency scope
-- distinct, so a changed decision under a reused key correctly conflicts
-- rather than silently overwriting a different verdict.
-- ─────────────────────────────────────────
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

  -- listing_history is merchant-readable for this listing (Phase 0 RLS) --
  -- deliberately carries only the status transition, never reason_code or
  -- reviewer_notes (internal). merchant_feedback is safe by design and
  -- included so the merchant's own history view can show it without a
  -- second query. Full internal detail goes to admin_action_history below.
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

-- ─────────────────────────────────────────
-- decide_moderation — approve / reject / requires_review (request
-- changes). 'rejected' and 'requires_review' both revert listings.status
-- to 'draft' -- "listing moves to a correct editable state" -- which
-- means the merchant's EXISTING submit_listing_for_review flow already
-- handles resubmission with no new RPC: it re-upserts listing_moderation
-- back to 'pending' and appends fresh listing_declarations /
-- listing_history rows, none of which needed to change for this phase.
-- 'flagged' is deliberately NOT reverted to draft here -- it's an
-- escalation for senior review, not a verdict the merchant can act on by
-- editing, so the listing stays wherever it currently is.
-- 'approved' does not touch listings.status at all -- reaching 'active'
-- is always a separate, explicit activate_listing call, never implied by
-- a moderation decision alone.
-- ─────────────────────────────────────────
create or replace function public.decide_moderation(
  p_listing_id uuid,
  p_admin_id uuid,
  p_decision moderation_status,
  p_reason_code text,
  p_internal_note text,
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
  v_existing_status moderation_status;
  v_listing_status listing_status;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_admin_id is null then
    raise exception 'not authenticated';
  end if;
  if p_decision not in ('approved', 'rejected', 'requires_review', 'flagged') then
    raise exception 'invalid moderation decision';
  end if;

  select status into v_listing_status from public.listings where id = p_listing_id;
  if v_listing_status is null then
    raise exception 'listing not found';
  end if;

  v_operation := 'decide_moderation:' || p_decision::text;
  v_request_hash := md5(
    coalesce(p_listing_id::text, '') || '|' || coalesce(p_reason_code, '') || '|' ||
    coalesce(p_internal_note, '') || '|' || coalesce(p_merchant_feedback, '')
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

  select moderation_status into v_existing_status
  from public.listing_moderation where listing_id = p_listing_id;

  insert into public.listing_moderation (
    listing_id, moderation_status, moderation_notes, moderated_by, moderated_at, rejection_reason
  ) values (
    p_listing_id, p_decision, p_internal_note, p_admin_id, v_now,
    case when p_decision in ('rejected', 'requires_review') then p_merchant_feedback else null end
  )
  on conflict (listing_id) do update set
    moderation_status = p_decision,
    moderation_notes = p_internal_note,
    moderated_by = p_admin_id,
    moderated_at = v_now,
    rejection_reason = case when p_decision in ('rejected', 'requires_review') then p_merchant_feedback else null end,
    updated_at = v_now;

  if p_decision in ('rejected', 'requires_review') and v_listing_status <> 'draft' then
    update public.listings set status = 'draft' where id = p_listing_id;
  end if;

  -- Same split as decide_ownership_verification above: listing_history
  -- gets only the status transition + merchant_feedback (it's
  -- merchant-readable); reason_code and internal_note go to
  -- admin_action_history only.
  insert into public.listing_history (listing_id, changed_by, old_values, new_values, change_reason)
  values (
    p_listing_id, p_admin_id,
    jsonb_build_object('moderation_status', coalesce(v_existing_status::text, 'none'), 'listing_status', v_listing_status),
    jsonb_build_object(
      'moderation_status', p_decision,
      'merchant_feedback', case when p_decision in ('rejected', 'requires_review') then p_merchant_feedback else null end,
      'listing_status', case when p_decision in ('rejected', 'requires_review') then 'draft' else v_listing_status::text end
    ),
    'moderation_' || p_decision::text
  );

  insert into public.admin_action_history (
    listing_id, action_type, admin_id, reason_code, internal_note, merchant_feedback, previous_status, new_status
  ) values (
    p_listing_id, 'moderation_' || p_decision::text, p_admin_id, p_reason_code, p_internal_note, p_merchant_feedback,
    coalesce(v_existing_status::text, 'none'), p_decision::text
  );

  v_result := jsonb_build_object('listing_id', p_listing_id, 'moderation_status', p_decision);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_admin_id, v_operation, p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

-- ─────────────────────────────────────────
-- activate_listing — the only path that may ever set status = 'active'.
-- Deliberately re-checks only what's cheap and authoritative in SQL
-- (current status, moderation approved, not flagged) -- the full
-- completeness engine (photo counts, category fields, risk-tier
-- requirements) runs once, in TypeScript
-- (src/lib/listings/activation.ts), against the listing's actual
-- persisted state, exactly mirroring why submit_listing_for_review()
-- does not duplicate src/lib/listings/completeness.ts in SQL either. This
-- function is reachable only via service_role, so a client cannot skip
-- that TypeScript check by calling it directly.
--
-- Allowed FROM 'pending' (the normal path) or 'suspended' (the permitted
-- recovery action for a previously-suspended listing whose moderation
-- approval still stands) -- both go through the exact same eligibility
-- re-check, so reactivating a suspended listing is never a shortcut.
-- ─────────────────────────────────────────
create or replace function public.activate_listing(
  p_listing_id uuid,
  p_admin_id uuid,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_request_hash text;
  v_idem record;
  v_listing_status listing_status;
  v_moderation_status moderation_status;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_admin_id is null then
    raise exception 'not authenticated';
  end if;

  v_request_hash := md5(coalesce(p_listing_id::text, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_admin_id and operation = 'activate_listing' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select status into v_listing_status from public.listings where id = p_listing_id;
  if v_listing_status is null then
    raise exception 'listing not found';
  end if;
  if v_listing_status not in ('pending', 'suspended') then
    raise exception 'listing status "%" is not eligible for activation', v_listing_status;
  end if;

  select moderation_status into v_moderation_status
  from public.listing_moderation where listing_id = p_listing_id;

  if v_moderation_status is distinct from 'approved' then
    raise exception 'listing has not been approved by moderation';
  end if;

  update public.listings set status = 'active' where id = p_listing_id;

  insert into public.listing_history (listing_id, changed_by, old_values, new_values, change_reason)
  values (
    p_listing_id, p_admin_id,
    jsonb_build_object('listing_status', v_listing_status),
    jsonb_build_object('listing_status', 'active'),
    'listing_activated'
  );

  insert into public.admin_action_history (listing_id, action_type, admin_id, previous_status, new_status)
  values (p_listing_id, 'listing_activated', p_admin_id, v_listing_status::text, 'active');

  v_result := jsonb_build_object('listing_id', p_listing_id, 'status', 'active');

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_admin_id, 'activate_listing', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

-- ─────────────────────────────────────────
-- suspend_listing — pulls an 'active' listing out of circulation
-- administratively. Distinct from the merchant's own 'active' -> 'paused'
-- self-service transition (unchanged, still merchant-direct per
-- protect_listing_privileged_fields). Recovery is activate_listing above,
-- which re-runs the full eligibility check rather than a bare
-- status flip.
-- ─────────────────────────────────────────
create or replace function public.suspend_listing(
  p_listing_id uuid,
  p_admin_id uuid,
  p_reason_code text,
  p_internal_note text,
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
  v_request_hash text;
  v_idem record;
  v_listing_status listing_status;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_admin_id is null then
    raise exception 'not authenticated';
  end if;

  v_request_hash := md5(
    coalesce(p_listing_id::text, '') || '|' || coalesce(p_reason_code, '') || '|' ||
    coalesce(p_internal_note, '') || '|' || coalesce(p_merchant_feedback, '')
  );

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_admin_id and operation = 'suspend_listing' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select status into v_listing_status from public.listings where id = p_listing_id;
  if v_listing_status is null then
    raise exception 'listing not found';
  end if;
  if v_listing_status <> 'active' then
    raise exception 'only an active listing can be suspended';
  end if;

  update public.listings set status = 'suspended' where id = p_listing_id;

  -- Deliberately does NOT touch listing_moderation -- suspension is a
  -- listings.status concern (is this bookable right now), not a change to
  -- the underlying moderation verdict. Leaving moderation_status
  -- untouched (still 'approved' from before) is what lets
  -- activate_listing's reactivation path work correctly: it re-checks
  -- moderation_status = 'approved', which must still be true after a
  -- suspend/reactivate cycle that didn't involve a new moderation
  -- decision.
  --
  -- listing_history gets only the status transition + merchant_feedback
  -- (merchant-readable); reason_code and internal_note go to
  -- admin_action_history only, same split as the other decision RPCs.
  insert into public.listing_history (listing_id, changed_by, old_values, new_values, change_reason)
  values (
    p_listing_id, p_admin_id,
    jsonb_build_object('listing_status', 'active'),
    jsonb_build_object('listing_status', 'suspended', 'merchant_feedback', p_merchant_feedback),
    'listing_suspended'
  );

  insert into public.admin_action_history (
    listing_id, action_type, admin_id, reason_code, internal_note, merchant_feedback, previous_status, new_status
  ) values (
    p_listing_id, 'listing_suspended', p_admin_id, p_reason_code, p_internal_note, p_merchant_feedback, 'active', 'suspended'
  );

  v_result := jsonb_build_object('listing_id', p_listing_id, 'status', 'suspended');

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_admin_id, 'suspend_listing', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

revoke all on function public.start_ownership_review(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.start_ownership_review(uuid, uuid, text) to service_role;

revoke all on function public.decide_ownership_verification(uuid, uuid, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.decide_ownership_verification(uuid, uuid, text, text, text, text, text) to service_role;

revoke all on function public.decide_moderation(uuid, uuid, moderation_status, text, text, text, text) from public, anon, authenticated;
grant execute on function public.decide_moderation(uuid, uuid, moderation_status, text, text, text, text) to service_role;

revoke all on function public.activate_listing(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.activate_listing(uuid, uuid, text) to service_role;

revoke all on function public.suspend_listing(uuid, uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.suspend_listing(uuid, uuid, text, text, text, text) to service_role;
