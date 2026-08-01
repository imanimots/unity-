-- ============================================================
-- Fix submit_listing_for_review() to allow resubmission
-- ============================================================
-- Found live during Step 3 Scenario B validation: request-changes/reject
-- correctly reverts listings.status to 'draft' so the merchant can edit
-- and resubmit through the EXISTING submit_listing_for_review() flow (no
-- new resubmission RPC was built -- see 20260803000003's own comment).
-- But that flow was completely broken for any second submission --
-- listing_declarations has a unique constraint on
-- (listing_id, declaration_type) (20260729000008), and the original
-- function did a plain INSERT per declaration on every call. A merchant's
-- first submission succeeds; their resubmission after changes-required
-- fails outright with a 23505 unique-violation, since the same
-- declaration_type rows already exist from the first submission.
--
-- Fixed with the smallest safe change: upsert instead of insert, so a
-- resubmission updates each declaration_type's row to the current
-- acceptance (version, hash, accepted_at) rather than trying to add a
-- second row for the same type. This trades away literal
-- one-row-per-historical-acceptance for one-row-per-type-currently-accepted
-- -- an acceptable loss since that granularity was never actually
-- reachable before (the constraint always blocked a real second
-- submission), and the decisions that must stay auditable across a
-- resubmission (moderation/ownership verdicts) already live in
-- listing_history / admin_action_history, untouched by this change.
--
-- Everything else in this function is unchanged from
-- 20260730000002_restrict_submit_to_server.sql.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

create or replace function public.submit_listing_for_review(
  p_listing_id uuid,
  p_merchant_id uuid,
  p_declaration_types declaration_type[],
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid;
  v_type declaration_type;
  v_now timestamptz := now();
  v_version text;
  v_hash text;
  v_required_count int;
  v_provided_count int;
  v_request_hash text;
  v_idem record;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;

  v_uid := p_merchant_id;
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  v_request_hash := md5(coalesce(p_listing_id::text, '') || '|' || coalesce(p_declaration_types::text, '{}'));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = v_uid and operation = 'submit_listing_for_review' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  if not exists (
    select 1 from public.listings
    where id = p_listing_id and merchant_id = v_uid and status = 'draft'
  ) then
    raise exception 'listing not found, not owned by caller, or not in draft status';
  end if;

  select count(distinct declaration_type) into v_required_count
  from public.declaration_catalogue where is_active;

  select count(distinct t) into v_provided_count
  from unnest(coalesce(p_declaration_types, array[]::declaration_type[])) as t;

  if v_provided_count < v_required_count then
    raise exception 'all required declarations must be accepted before submission';
  end if;

  -- Upsert (see header) -- a resubmission re-accepts each declaration_type
  -- rather than colliding with the unique constraint on
  -- (listing_id, declaration_type) left over from a prior submission.
  foreach v_type in array (select array_agg(distinct t) from unnest(p_declaration_types) as t)
  loop
    select version, wording_hash into v_version, v_hash
    from public.declaration_catalogue
    where declaration_type = v_type and is_active
    order by effective_date desc
    limit 1;

    if v_version is null then
      raise exception 'no active declaration catalogue entry for %', v_type;
    end if;

    insert into public.listing_declarations (
      listing_id, merchant_id, declaration_type, declaration_version,
      declaration_text_hash, accepted, accepted_at
    ) values (
      p_listing_id, v_uid, v_type, v_version, v_hash, true, v_now
    )
    on conflict (listing_id, declaration_type) do update set
      merchant_id = excluded.merchant_id,
      declaration_version = excluded.declaration_version,
      declaration_text_hash = excluded.declaration_text_hash,
      accepted = excluded.accepted,
      accepted_at = excluded.accepted_at;
  end loop;

  insert into public.listing_moderation (listing_id, moderation_status)
  values (p_listing_id, 'pending')
  on conflict (listing_id) do update set moderation_status = 'pending', updated_at = v_now;

  update public.listings set status = 'pending' where id = p_listing_id;

  insert into public.listing_history (listing_id, changed_by, old_values, new_values, change_reason)
  values (
    p_listing_id, v_uid,
    jsonb_build_object('status', 'draft'),
    jsonb_build_object('status', 'pending'),
    'listing_submitted_for_review'
  );

  v_result := jsonb_build_object('listing_id', p_listing_id, 'status', 'pending');

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (v_uid, 'submit_listing_for_review', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

revoke all on function public.submit_listing_for_review(uuid, uuid, declaration_type[], text) from public;
revoke all on function public.submit_listing_for_review(uuid, uuid, declaration_type[], text) from anon;
revoke all on function public.submit_listing_for_review(uuid, uuid, declaration_type[], text) from authenticated;
grant execute on function public.submit_listing_for_review(uuid, uuid, declaration_type[], text) to service_role;
