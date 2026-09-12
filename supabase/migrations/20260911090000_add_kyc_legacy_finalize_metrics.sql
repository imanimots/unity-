-- ============================================================
-- Unity -- KYC Orphan Cleanup Phase B3M -- durable, non-identifying
-- observability for the legacy no-intent finalization compatibility
-- path (finalizeViaLegacyBody() in
-- src/app/api/verification/documents/route.ts).
--
-- Purpose: give a future B3B cutover decision (retiring the legacy
-- no-intent finalization body) a durable signal that survives beyond
-- console logs -- "are authenticated clients still exercising the
-- legacy no-intent finalization contract at all". One row per UTC
-- calendar day, one counter, zero identifying columns: no user id, no
-- document id, no storage path, no MIME type, no file size, no IP, no
-- user agent, no KYC content of any kind.
--
-- Metric boundary (enforced in the route, not here): the caller
-- increments this AFTER the B2L intent-ownership gate proves the
-- request's storage_path belongs to zero kyc_document_upload_intents
-- rows, and BEFORE the existing-row/replay lookup, the Storage
-- existence check, or the metadata insert. Every request that reaches
-- that point is a genuine authenticated legacy no-intent attempt,
-- counted as request volume (retries count again, no deduplication) --
-- whatever happens downstream (replay, conflict, Storage failure,
-- insert failure, or insert success) does not change whether it was
-- attempted. B3A intent finalizations, B2L-rejected intent-owned
-- paths, and unauthenticated/malformed requests never reach this
-- boundary and are never counted.
--
-- Reliability model: FAIL CLOSED. record_kyc_legacy_finalize_attempt()
-- is the only writer, is service-role only, and the calling route MUST
-- abort the legacy request (no replay lookup, no Storage check, no
-- metadata insert) if this RPC errors -- a broken recorder must turn
-- into a visible failure for that one deprecated compatibility path,
-- never into a silently uncounted "false zero" for the eventual B3B
-- decision.
-- ============================================================

create table if not exists public.kyc_legacy_finalize_daily_metrics (
  bucket_date           date primary key,
  legacy_attempt_count  bigint not null default 0 check (legacy_attempt_count >= 0),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- RLS enabled, ZERO client-facing policies -- matches
-- kyc_document_upload_intents' own posture exactly. The only writer is
-- record_kyc_legacy_finalize_attempt() below; the only intended reader
-- is a service-role operational reporting script. No anon/authenticated
-- SELECT, no owner concept applies (there is no per-row owner), no
-- admin browser policy.
alter table public.kyc_legacy_finalize_daily_metrics enable row level security;

-- No CREATE POLICY statement of any kind for this table -- deliberate.

create or replace function public.record_kyc_legacy_finalize_attempt()
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  -- Belt-and-suspenders caller guard -- the GRANT below already
  -- restricts EXECUTE to service_role, this is a second, independent
  -- check inside the function body itself.
  --
  -- Deliberately `IS DISTINCT FROM`, not `<>`: auth.role() can return
  -- SQL NULL (e.g. no request.jwt.claim.role setting present at all,
  -- such as a direct superuser/psql invocation outside PostgREST).
  -- `NULL <> 'service_role'` evaluates to NULL, and PL/pgSQL's `IF`
  -- treats a NULL condition as false -- silently skipping the RAISE
  -- and falling through to the increment. `IS DISTINCT FROM` is a
  -- three-valued-logic-safe comparison that never itself returns NULL,
  -- so a NULL caller role is correctly treated as "not service_role"
  -- and rejected. (The existing claim_expired_kyc_upload_intents
  -- precedent this pattern was drawn from uses the NULL-unsafe `<>`
  -- form; that migration is already applied and immutable, so this is
  -- a deliberate, narrow improvement made only here, not a backport.)
  if auth.role() is distinct from 'service_role' then
    raise exception 'not_authorized';
  end if;

  -- Single atomic upsert -- no read-then-write race. Bucketed by
  -- Postgres' own UTC clock, never client/request-supplied time, and
  -- explicitly timezone-independent (not bare current_date, which is
  -- session TimeZone-dependent).
  insert into public.kyc_legacy_finalize_daily_metrics (bucket_date, legacy_attempt_count)
  values ((pg_catalog.now() at time zone 'utc')::date, 1)
  on conflict (bucket_date) do update
  set legacy_attempt_count = public.kyc_legacy_finalize_daily_metrics.legacy_attempt_count + 1,
      updated_at = pg_catalog.now();
end;
$$;

-- Zero application-supplied parameters -- the function determines the
-- UTC bucket and the increment itself; nothing is ever accepted from
-- the caller (no user id, path, document data, outcome text, arbitrary
-- date, or arbitrary increment value).
revoke all on function public.record_kyc_legacy_finalize_attempt() from public, anon, authenticated;
grant execute on function public.record_kyc_legacy_finalize_attempt() to service_role;
