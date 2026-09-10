-- ============================================================
-- KYC B3C -- expiry cleaner foundation
-- ============================================================
-- Two things only:
--   1. Widen kyc_document_upload_intents' status CHECK to allow the
--      new terminal state `preserved` (an intent whose exact
--      storage_path turned out to be registered in
--      identity_verification_documents through some path other than its
--      own finalize transaction -- Storage is never deleted and the
--      intent is retired from cleanup scanning).
--   2. Add claim_expired_kyc_upload_intents() -- a service-role-only
--      SECURITY DEFINER function that atomically claims a bounded batch
--      of cleanup candidates (first-time `pending`+past-deadline rows,
--      durably transitioned to `expired` in the same transaction, plus
--      already-`expired` retry rows), and returns just enough per-row
--      data for the internal cleanup route to do its Storage work.
--
-- The route (POST /api/internal/kyc/cleanup-upload-intents) and the
-- per-candidate terminal transitions (expired -> cleaned | preserved)
-- live in application code -- the terminal transitions are simple
-- single-row conditional UPDATEs (`WHERE id = $1 AND status = 'expired'`)
-- via the service-role client, race-safe against concurrent workers by
-- the status guard, so they need no function here.
--
-- Structural safety (KYC B3C authority gates): once a `pending` intent
-- is transitioned to `expired` by the first-time claim below, NO
-- application-accessible metadata writer can register its storage_path:
--   * finalize_kyc_document_upload() -- predicate is status='pending';
--     an expired intent raises intent_expired, no insert.
--   * finalizeViaLegacyBody() -- rejects (409) ANY intent-owned
--     storage_path before any privileged insert (B2L, 20260910122503).
--   * direct authenticated INSERT -- the "owner insert" policy is gone
--     (B2L); RLS denies it.
-- The cleanup helper additionally re-runs a fresh
-- identity_verification_documents existence check by exact path
-- immediately before every Storage delete -- registered evidence
-- always wins.
--
-- No change to: identity_verification_documents (policies/trigger),
-- finalize_kyc_document_upload() (body/ACL/search_path), Storage RLS,
-- the intent-creation route, the client, provider/status systems, or
-- any scheduler.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

-- ─────────────────────────────────────────
-- 1. Allow the `preserved` terminal state
-- ─────────────────────────────────────────
-- Exact live constraint name/expression confirmed via pg_constraint:
--   kyc_document_upload_intents_status_check
--   CHECK ((status = ANY (ARRAY['pending','finalized','expired','cleaned'])))
alter table public.kyc_document_upload_intents
  drop constraint kyc_document_upload_intents_status_check;

alter table public.kyc_document_upload_intents
  add constraint kyc_document_upload_intents_status_check
  check (status in ('pending', 'finalized', 'expired', 'cleaned', 'preserved'));

-- ─────────────────────────────────────────
-- 2. claim_expired_kyc_upload_intents -- bounded, race-safe batch claim
-- ─────────────────────────────────────────
-- Mirrors this repo's own established internal-sweep claim pattern
-- (public.expire_marketplace_requests / execute_due_scheduled_publications
-- -- SECURITY DEFINER, auth.role() guard, FOR UPDATE SKIP LOCKED,
-- aggregate jsonb return, revoke-from-public/anon/authenticated +
-- grant-to-service_role). search_path is pinned to pg_catalog (this
-- KYC domain's own stricter B3A convention) with every application
-- object schema-qualified.
create or replace function public.claim_expired_kyc_upload_intents(p_limit int default 100)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_limit      int := least(greatest(coalesce(p_limit, 100), 1), 100);
  v_first_ids  uuid[];
  v_retry_ids  uuid[];
  v_candidates jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not_authorized';
  end if;

  -- First-time pass: pending intents past their database-time deadline.
  -- The pending -> expired transition commits with this function's
  -- transaction, BEFORE the route does any Storage work -- that is the
  -- durable lifecycle claim that blocks finalization.
  with claimed as (
    select id
    from public.kyc_document_upload_intents
    where status = 'pending' and expires_at <= now()
    order by expires_at asc, id asc
    limit v_limit
    for update skip locked
  ),
  updated as (
    update public.kyc_document_upload_intents i
    set status = 'expired'
    from claimed c
    where i.id = c.id
    returning i.id
  )
  select coalesce(array_agg(id), '{}'::uuid[]) into v_first_ids from updated;

  -- Retry pass: fill any remaining budget from rows already in
  -- `expired`. Explicitly exclude the ids just claimed above so a row
  -- transitioned in THIS call can never also be returned as a retry
  -- candidate in the same call.
  with retry as (
    select id
    from public.kyc_document_upload_intents
    where status = 'expired' and id <> all(v_first_ids)
    order by expires_at asc, id asc
    limit greatest(v_limit - coalesce(array_length(v_first_ids, 1), 0), 0)
    for update skip locked
  )
  select coalesce(array_agg(id), '{}'::uuid[]) into v_retry_ids from retry;

  select coalesce(jsonb_agg(row_to_json(c)), '[]'::jsonb) into v_candidates
  from (
    select
      i.id,
      i.user_id,
      i.document_type,
      i.storage_path,
      (i.id = any(v_retry_ids)) as is_retry
    from public.kyc_document_upload_intents i
    where i.id = any(v_first_ids) or i.id = any(v_retry_ids)
    order by (i.id = any(v_retry_ids)), i.expires_at asc, i.id asc
  ) c;

  return jsonb_build_object('candidates', v_candidates);
end;
$$;

revoke all on function public.claim_expired_kyc_upload_intents(int) from public, anon, authenticated;
grant execute on function public.claim_expired_kyc_upload_intents(int) to service_role;
