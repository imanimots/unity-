-- ============================================================
-- Drop listing_declarations_listing_type_uniq; revert to plain INSERT
-- ============================================================
-- 20260803000005's upsert fix was itself wrong: listing_declarations has
-- a hard `prevent_row_mutation()` trigger (20260729000003) that raises
-- unconditionally on UPDATE/DELETE for every role, including
-- service_role, by explicit design ("there's never a legitimate reason
-- to alter an accepted declaration"). An `ON CONFLICT ... DO UPDATE`
-- upsert hits that trigger just as hard as a raw UPDATE does -- found
-- live immediately after applying 000005, when the same resubmission
-- attempt now failed with "listing_declarations records are immutable"
-- instead of the original unique-violation.
--
-- The real conflict is between two constraints that were never meant to
-- coexist: `listing_declarations_listing_type_uniq`
-- (20260729000008_listing_wizard_closure.sql, unique on
-- (listing_id, declaration_type)) and the immutability trigger. Given the
-- table is genuinely append-only (each row an accepted-at snapshot,
-- immutable once written -- see 20260729000003's own header comment: "one
-- row per declaration acceptance, not one row per listing"), the unique
-- constraint is the one that's wrong -- it enforces "at most once ever"
-- on a table explicitly designed to record multiple acceptances over
-- time (one per resubmission). Dropping it is schema relaxation, not a
-- destructive change: no data is deleted, no column or table is dropped,
-- no existing row is rewritten.
--
-- submit_listing_for_review() reverts to a plain INSERT (its original
-- 20260730000002 shape) now that a second acceptance of the same
-- declaration_type for the same listing is a legitimate, allowed row,
-- not a conflict.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

alter table public.listing_declarations
  drop constraint if exists listing_declarations_listing_type_uniq;

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

  -- Plain insert -- each call (including a resubmission) appends a fresh
  -- accepted-at row per declaration_type; no conflict target exists now
  -- that the unique constraint above is gone, and none is needed since
  -- these rows are immutable, never updated.
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
    );
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
