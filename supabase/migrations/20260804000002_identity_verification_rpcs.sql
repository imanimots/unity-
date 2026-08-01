-- ============================================================
-- Identity verification RPCs (Step 4, public-test MVP)
-- ============================================================
-- Same trust model as every RPC since submit_listing_for_review()
-- (20260730000002) and Step 3's admin moderation RPCs
-- (20260803000003): SECURITY DEFINER, refuses to run for anyone but
-- service_role, takes the acting user's id as an explicit parameter (a
-- service-role session has no auth.uid()), self-contained (idempotency
-- check, state validation, mutation, history write, all in one
-- function call). The calling API route independently verifies the
-- caller's identity (getRequestProfile() / requireAdmin()) before ever
-- reaching these.
--
-- Idempotency reuses idempotency_keys exactly as established --
-- submit_identity_verification is scoped by the SUBMITTING USER's own
-- id (already a profiles.id, no FK issue); the two admin RPCs are
-- scoped by the ADMIN's id, same as Step 3.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

-- ─────────────────────────────────────────
-- submit_identity_verification -- initial submission AND resubmission,
-- one function (mirrors submit_listing_for_review's single-function
-- shape). Allowed FROM 'not_started', 'additional_information_required',
-- or 'rejected' -- NOT from 'pending'/'under_review' (already being
-- reviewed) or 'approved' (already decided; a real revocation flow, if
-- ever needed, is out of scope this pass). Completeness (required legal
-- fields, required document types present) is judged once, in
-- src/lib/identity-verification/submit-service.ts, against the caller's
-- actual persisted documents -- NOT duplicated here, exactly mirroring
-- why submit_listing_for_review() doesn't duplicate
-- src/lib/listings/completeness.ts in SQL either.
-- ─────────────────────────────────────────
create or replace function public.submit_identity_verification(
  p_user_id uuid,
  p_legal_first_name text,
  p_legal_surname text,
  p_date_of_birth date,
  p_id_reference_type identity_reference_type,
  p_id_reference_number text,
  p_nationality text,
  p_country_of_residence text,
  p_residential_address text,
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
  v_existing_status identity_verification_status;
  v_existing_review_count int;
  v_action_type text;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_user_id is null then
    raise exception 'not authenticated';
  end if;

  v_request_hash := md5(
    coalesce(p_legal_first_name, '') || '|' || coalesce(p_legal_surname, '') || '|' ||
    coalesce(p_date_of_birth::text, '') || '|' || coalesce(p_id_reference_type::text, '') || '|' ||
    coalesce(p_id_reference_number, '') || '|' || coalesce(p_nationality, '') || '|' ||
    coalesce(p_country_of_residence, '') || '|' || coalesce(p_residential_address, '')
  );

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_user_id and operation = 'submit_identity_verification' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select status, review_count into v_existing_status, v_existing_review_count
  from public.identity_verifications where user_id = p_user_id;

  if v_existing_status is not null and v_existing_status not in ('not_started', 'additional_information_required', 'rejected') then
    raise exception 'identity verification is not in a resubmittable state';
  end if;

  v_action_type := case when v_existing_status is null or v_existing_status = 'not_started' then 'submitted' else 'resubmitted' end;

  insert into public.identity_verifications (
    user_id, status, legal_first_name, legal_surname, date_of_birth,
    id_reference_type, id_reference_number, nationality, country_of_residence,
    residential_address, provider, submitted_at, updated_at
  ) values (
    p_user_id, 'pending', p_legal_first_name, p_legal_surname, p_date_of_birth,
    p_id_reference_type, p_id_reference_number, p_nationality, p_country_of_residence,
    p_residential_address, 'manual', v_now, v_now
  )
  on conflict (user_id) do update set
    status = 'pending',
    legal_first_name = excluded.legal_first_name,
    legal_surname = excluded.legal_surname,
    date_of_birth = excluded.date_of_birth,
    id_reference_type = excluded.id_reference_type,
    id_reference_number = excluded.id_reference_number,
    nationality = excluded.nationality,
    country_of_residence = excluded.country_of_residence,
    residential_address = excluded.residential_address,
    submitted_at = v_now,
    updated_at = v_now,
    review_count = identity_verifications.review_count + 1;

  update public.profiles set kyc_status = 'pending' where id = p_user_id;

  insert into public.identity_verification_history (user_id, action_type, admin_id, previous_status, new_status)
  values (p_user_id, v_action_type, null, coalesce(v_existing_status::text, 'none'), 'pending');

  -- Matches what's actually stored: a genuine first insert leaves
  -- review_count at its table default (0, no prior attempt yet); only a
  -- resubmission (conflict branch) increments it.
  v_result := jsonb_build_object(
    'user_id', p_user_id, 'status', 'pending',
    'review_count', case when v_existing_status is null then 0 else coalesce(v_existing_review_count, 0) + 1 end
  );

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_user_id, 'submit_identity_verification', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

-- ─────────────────────────────────────────
-- start_identity_review
-- ─────────────────────────────────────────
create or replace function public.start_identity_review(
  p_user_id uuid,
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
  v_existing_status identity_verification_status;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_admin_id is null then
    raise exception 'not authenticated';
  end if;
  if not exists (select 1 from public.identity_verifications where user_id = p_user_id) then
    raise exception 'no identity verification submission exists for this user';
  end if;

  v_request_hash := md5(coalesce(p_user_id::text, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_admin_id and operation = 'start_identity_review' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select status into v_existing_status from public.identity_verifications where user_id = p_user_id;

  if v_existing_status in ('approved', 'rejected') then
    raise exception 'identity verification already has a final decision and cannot be restarted';
  end if;

  update public.identity_verifications set status = 'under_review', updated_at = v_now where user_id = p_user_id;

  insert into public.identity_verification_history (user_id, action_type, admin_id, previous_status, new_status)
  values (p_user_id, 'review_started', p_admin_id, v_existing_status::text, 'under_review');

  v_result := jsonb_build_object('user_id', p_user_id, 'status', 'under_review');

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_admin_id, 'start_identity_review', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

-- ─────────────────────────────────────────
-- decide_identity_verification -- approved / rejected /
-- additional_information_required, one function (same reasoning as
-- Step 3's decide_ownership_verification -- identical state-machine
-- guard and history write for all three, only the target status/reason
-- and idempotency operation name differ). Syncs profiles.kyc_status
-- (public-safe coarse summary) on 'approved'/'rejected' -- the exact
-- same "sync a pre-existing public field from the richer private table"
-- pattern as Step 3's listings.ownership_verified fix
-- (20260803000004), applied correctly from the start this time.
-- ─────────────────────────────────────────
create or replace function public.decide_identity_verification(
  p_user_id uuid,
  p_admin_id uuid,
  p_decision text,
  p_reason_code text,
  p_reviewer_notes text,
  p_user_feedback text,
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
  v_existing_status identity_verification_status;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_admin_id is null then
    raise exception 'not authenticated';
  end if;
  if p_decision not in ('approved', 'rejected', 'additional_information_required') then
    raise exception 'invalid identity verification decision';
  end if;
  if not exists (select 1 from public.identity_verifications where user_id = p_user_id) then
    raise exception 'no identity verification submission exists for this user';
  end if;

  v_operation := 'decide_identity_verification:' || p_decision;
  v_request_hash := md5(
    coalesce(p_user_id::text, '') || '|' || coalesce(p_reason_code, '') || '|' ||
    coalesce(p_reviewer_notes, '') || '|' || coalesce(p_user_feedback, '')
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

  select status into v_existing_status from public.identity_verifications where user_id = p_user_id;

  if v_existing_status in ('approved', 'rejected') then
    raise exception 'identity verification already has a final decision';
  end if;

  update public.identity_verifications set
    status = p_decision::identity_verification_status,
    reason_code = p_reason_code,
    reviewer_notes = p_reviewer_notes,
    user_feedback = p_user_feedback,
    reviewed_by = p_admin_id,
    reviewed_at = v_now,
    updated_at = v_now
  where user_id = p_user_id;

  -- profiles.kyc_status sync -- 'additional_information_required' keeps
  -- the coarse public status at 'pending' (still not finalized either
  -- way; the legacy 4-value enum has no equivalent state), matching how
  -- Step 3 only synced listings.ownership_verified on the terminal
  -- 'verified' outcome.
  if p_decision = 'approved' then
    update public.profiles set kyc_status = 'approved' where id = p_user_id;
  elsif p_decision = 'rejected' then
    update public.profiles set kyc_status = 'rejected' where id = p_user_id;
  end if;

  insert into public.identity_verification_history (
    user_id, action_type, admin_id, reason_code, internal_note, user_feedback, previous_status, new_status
  ) values (
    p_user_id, 'decision_' || p_decision, p_admin_id, p_reason_code, p_reviewer_notes, p_user_feedback,
    v_existing_status::text, p_decision
  );

  v_result := jsonb_build_object('user_id', p_user_id, 'status', p_decision);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_admin_id, v_operation, p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

revoke all on function public.submit_identity_verification(uuid, text, text, date, identity_reference_type, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.submit_identity_verification(uuid, text, text, date, identity_reference_type, text, text, text, text, text) to service_role;

revoke all on function public.start_identity_review(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.start_identity_review(uuid, uuid, text) to service_role;

revoke all on function public.decide_identity_verification(uuid, uuid, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.decide_identity_verification(uuid, uuid, text, text, text, text, text) to service_role;
