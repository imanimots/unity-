-- ============================================================
-- Restrict submit_listing_for_review to the trusted server layer
-- ============================================================
-- Live validation confirmed that submit_listing_for_review() is directly
-- callable by any authenticated client via PostgREST. The RPC enforces
-- declaration completeness, ownership, draft status, and idempotency in
-- SQL, but deliberately does NOT duplicate the full completeness engine
-- (photo count, primary photo, ownership proof, category-specific fields,
-- deposit/licence coherence — src/lib/listings/completeness.ts). That
-- engine runs once, in src/app/api/listings/[id]/submit/route.ts, against
-- the listing's persisted state. A client able to reach the RPC directly
-- (bypassing the Next.js route) could therefore submit an incomplete
-- listing for moderation, skipping the one place completeness is judged.
--
-- Fix: make the RPC reachable only by the server's own service-role
-- credential, which never leaves the server (SUPABASE_SERVICE_ROLE_KEY is
-- not a NEXT_PUBLIC_ var and is never sent to the browser). This mirrors
-- the service-role pattern already used elsewhere in this codebase (see
-- src/app/api/affiliate/activate/route.ts) rather than inventing new
-- infrastructure. The completeness engine itself is not touched and is
-- still the single place completeness is evaluated — this migration only
-- narrows who may call the function that commits the result.
--
-- Since the caller is now always the server, auth.uid() (JWT-derived) can
-- no longer identify the merchant — a service-role session has no user
-- JWT. p_merchant_id is added as an explicit parameter instead, supplied
-- by the API route from its own already-verified session (the same
-- requester.userId already used for every other authorization check in
-- that route, e.g. the merchant-media-ownership check). This does not
-- weaken ownership validation: the route independently confirms
-- listingRow.merchant_id === requester.userId before ever reaching this
-- call, and the RPC's own ownership check below (listing must belong to
-- p_merchant_id and be in 'draft' status) is unchanged.
--
-- Everything else — declaration validation, declaration versioning,
-- listing_moderation creation, listing_history, idempotency — is
-- byte-for-byte unchanged from 20260729000008.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

drop function if exists public.submit_listing_for_review(uuid, declaration_type[], text);

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
  -- Defense in depth: even if the EXECUTE grant below were ever
  -- misconfigured, the function itself still refuses to run for anyone
  -- but the service role — the same belt-and-suspenders pattern already
  -- used by protect_listing_privileged_fields() elsewhere in this schema.
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

  -- Deduplicate before inserting — defense-in-depth alongside the unique
  -- constraint on listing_declarations (see 20260729000008's header).
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
