-- ============================================================
-- Unity -- Payment Webhook Inbox Hardening (P5D-M1)
-- ============================================================
-- payment_webhook_events (20260801000002_payment_schema.sql) has always
-- recorded a delivery's dedup key and a processing_status column, but
-- nothing in this codebase has ever transitioned that column away from
-- its insert-time default of 'received' -- record_webhook_event() only
-- ever inserts. The current webhook route
-- (src/app/api/payments/webhooks/[provider]/route.ts) treats
-- is_duplicate=true as "safe to no-op", which is correct only if the
-- original delivery actually finished reconciling. If the process
-- crashes/times out after the row is inserted but before reconciliation
-- completes, a provider retry of the same event_id hits the unique
-- constraint, is told "duplicate", and returns 200 -- reconciliation
-- then never happens, silently, because "seen" and "successfully
-- reconciled" were the same bit. This migration makes that distinction
-- real. See the P5D-A.1 phase report for the full crash-window proof
-- (exact route/RPC lines) this closes.
--
-- Provider-neutral by design -- no Peach-specific column or value
-- anywhere here, consistent with payment_webhook_events' own existing
-- (provider, provider_event_id) shape. Peach's own webhook envelope
-- (event_id/event_type/content/timestamp, confirmed in P5D-A.1) is an
-- application-layer concern (P5D-B), not something this schema encodes.
--
-- Source-only this phase -- NOT applied to any database. See the P5D-M1
-- phase report for the static-validation method used in place of a live
-- apply.
-- ============================================================

-- ------------------------------------------------------------
-- COLUMNS -- processing_started_at is the claim/lease timestamp
-- ("when did the current attempt start"), deliberately distinct from
-- received_at ("when did the delivery first arrive") -- conflating the
-- two would make a stale-lease reclaim indistinguishable from the
-- delivery's own original arrival time. processing_attempts and
-- last_error mirror the existing attempt-count/bounded-error-text shape
-- already used elsewhere in this schema (e.g.
-- kyc_document_finalize_metrics.legacy_attempt_count,
-- subscription_v2's `left(sqlerrm, 200)` truncation pattern) rather than
-- inventing a new convention.
-- ------------------------------------------------------------
alter table public.payment_webhook_events
  add column if not exists processing_started_at timestamptz,
  add column if not exists processed_at timestamptz,
  add column if not exists processing_attempts integer not null default 0 check (processing_attempts >= 0),
  add column if not exists last_error text check (last_error is null or char_length(last_error) <= 500);

-- Existing rows (processing_status='received', the only value any row
-- has ever actually been set to, since nothing has ever updated this
-- column) remain valid: the new columns are all nullable/defaulted, and
-- 'received' stays in the allowed set below.
alter table public.payment_webhook_events
  drop constraint if exists payment_webhook_events_processing_status_check;
alter table public.payment_webhook_events
  add constraint payment_webhook_events_processing_status_check
  check (processing_status in ('received', 'processing', 'processed', 'ignored', 'error'));

-- ------------------------------------------------------------
-- CLAIM_WEBHOOK_EVENT_PROCESSING -- the one atomic claim primitive.
--
-- A single conditional UPDATE ... WHERE ... RETURNING, not a
-- SELECT-then-UPDATE: Postgres serializes concurrent UPDATEs against the
-- same row, so a second concurrent claim attempt blocks until the first
-- commits, then re-evaluates this WHERE clause against the now-current
-- (already 'processing', already-fresh-leased) row and matches zero
-- rows -- no race window, no double claim, by construction of a single
-- statement rather than two.
--
-- Eligible source states: 'received' or 'error' (a definite
-- this-attempt-is-over signal, immediately retryable), or 'processing'
-- but only when processing_started_at is older than the caller-supplied
-- stale threshold -- p_stale_after_seconds has no default so the DB
-- schema never encodes Peach's own retry cadence (P5D-B decides that
-- policy). 'processed' and 'ignored' are terminal and never reclaimable
-- through this function -- they are simply absent from the WHERE
-- clause's eligibility set, not separately rejected.
--
-- received_at is never written here -- only the original insert
-- (record_webhook_event) sets it, preserving "first arrival" as a fact
-- distinct from any later claim.
-- ------------------------------------------------------------
create or replace function public.claim_webhook_event_processing(
  p_provider text,
  p_provider_event_id text,
  p_stale_after_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.payment_webhook_events;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_stale_after_seconds is null or p_stale_after_seconds <= 0 then
    raise exception 'stale threshold must be a positive number of seconds';
  end if;

  update public.payment_webhook_events
  set processing_status = 'processing',
      processing_started_at = now(),
      processing_attempts = processing_attempts + 1,
      last_error = null
  where provider = p_provider
    and provider_event_id = p_provider_event_id
    and (
      processing_status in ('received', 'error')
      or (processing_status = 'processing' and processing_started_at < now() - make_interval(secs => p_stale_after_seconds))
    )
  returning * into v_row;

  if v_row.id is not null then
    return jsonb_build_object(
      'claimed', true,
      'processing_status', v_row.processing_status,
      'processing_attempts', v_row.processing_attempts
    );
  end if;

  -- Not claimed -- either already processed/ignored, currently owned by
  -- a fresh (non-stale) lease, or the row doesn't exist yet. Report
  -- current state either way so the caller can tell those apart without
  -- a second round-trip.
  select * into v_row from public.payment_webhook_events
  where provider = p_provider and provider_event_id = p_provider_event_id;

  return jsonb_build_object(
    'claimed', false,
    'processing_status', v_row.processing_status,
    'processing_attempts', coalesce(v_row.processing_attempts, 0)
  );
end;
$$;

-- ------------------------------------------------------------
-- MARK_WEBHOOK_EVENT_PROCESSED -- the completion path.
--
-- P5D-M1-R found the first version of this function unconditional on
-- source processing_status, matched only by (provider,
-- provider_event_id) -- claim_webhook_event_processing's own returned
-- processing_attempts value was telemetry-only, never enforced. That let
-- a stale worker (one whose lease had already been reclaimed by a
-- second, newer claim) still finalize the row out from under the
-- worker that actually owns the current attempt. P5D-M1.1 fixes this by
-- making processing_attempts a genuine fencing token: the mutating
-- UPDATE below only ever matches a row that is BOTH currently
-- 'processing' AND still on exactly the attempt number the caller
-- claimed -- a stale caller's token can never match once a newer claim
-- has incremented it, because the row's processing_attempts has already
-- moved on.
--
-- Distinguishes three outcomes without mutation when the fenced UPDATE
-- affects zero rows (the reporting SELECT below runs strictly AFTER
-- that UPDATE has already made -- and lost -- its atomic attempt, never
-- before it, so it never controls whether a mutation happens):
--   already_processed -- same token, already 'processed' (this exact
--     worker's own earlier call already landed; a retry after a lost
--     response). No mutation, processed_at is NOT refreshed, so a retry
--     can never be told apart from the original success by timestamp.
--   lost_claim -- processing_attempts on the row no longer matches the
--     caller's token: someone else has reclaimed this event since.
--   invalid_state -- same token, but the row is in a status this
--     function was never meant to complete from (e.g. 'ignored', or a
--     status that only a genuine claim produces) -- reported rather
--     than silently mutated or silently ignored.
-- A row that genuinely does not exist raises an exception (the only
-- case an exception is used for -- every ownership-related outcome
-- above is a structured, non-exceptional 'outcome' value, so the caller
-- never has to infer ownership from exception text).
-- ------------------------------------------------------------
create or replace function public.mark_webhook_event_processed(
  p_provider text,
  p_provider_event_id text,
  p_expected_processing_attempt integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.payment_webhook_events;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_provider is null or p_provider = '' then
    raise exception 'provider is required';
  end if;
  if p_provider_event_id is null or p_provider_event_id = '' then
    raise exception 'provider_event_id is required';
  end if;
  if p_expected_processing_attempt is null or p_expected_processing_attempt <= 0 then
    raise exception 'expected processing attempt must be a positive number';
  end if;

  update public.payment_webhook_events
  set processing_status = 'processed',
      processed_at = now(),
      processing_started_at = null,
      last_error = null
  where provider = p_provider
    and provider_event_id = p_provider_event_id
    and processing_status = 'processing'
    and processing_attempts = p_expected_processing_attempt
  returning * into v_row;

  if v_row.id is not null then
    return jsonb_build_object('outcome', 'completed', 'processing_status', v_row.processing_status, 'processing_attempts', v_row.processing_attempts);
  end if;

  select * into v_row from public.payment_webhook_events
  where provider = p_provider and provider_event_id = p_provider_event_id;

  if v_row.id is null then
    raise exception 'webhook event not found for provider % / event %', p_provider, p_provider_event_id;
  end if;

  if v_row.processing_status = 'processed' and v_row.processing_attempts = p_expected_processing_attempt then
    return jsonb_build_object('outcome', 'already_processed', 'processing_status', v_row.processing_status, 'processing_attempts', v_row.processing_attempts);
  end if;

  if v_row.processing_attempts <> p_expected_processing_attempt then
    return jsonb_build_object('outcome', 'lost_claim', 'processing_status', v_row.processing_status, 'processing_attempts', v_row.processing_attempts);
  end if;

  return jsonb_build_object('outcome', 'invalid_state', 'processing_status', v_row.processing_status, 'processing_attempts', v_row.processing_attempts);
end;
$$;

-- ------------------------------------------------------------
-- MARK_WEBHOOK_EVENT_ERROR -- the retryable-failure path. Same
-- token-fenced ownership model as mark_webhook_event_processed above
-- (P5D-M1.1 -- see that function's comment for the stale-worker defect
-- this closes for both completion paths). Clears the lease
-- (processing_started_at = null) on a genuine first error so the event
-- is immediately eligible for claim_webhook_event_processing's 'error'
-- branch, rather than waiting out a stale-lease window for a failure
-- the current attempt already knows is over.
--
-- Same-token retry (already_error) deliberately does NOT overwrite
-- last_error -- the first durable error record for a given attempt is
-- preserved rather than replaced by whatever message a retried call
-- happens to carry, since both calls describe the same underlying
-- failure and the first is no less authoritative than the second.
-- p_last_error itself is truncated to 500 characters (same
-- bounded-diagnostic-text convention as
-- subscription_v2_scheduled_publishing.sql's `left(sqlerrm, 200)`)
-- before storage on the one path that does write it -- the CALLER
-- (P5D-B) remains responsible for never passing an API key, custom
-- webhook secret, payment_response_hash_key, raw provider payload, or
-- unbounded stack trace as p_last_error; this function only bounds
-- length, it cannot itself distinguish a secret from an ordinary error
-- string.
-- ------------------------------------------------------------
create or replace function public.mark_webhook_event_error(
  p_provider text,
  p_provider_event_id text,
  p_expected_processing_attempt integer,
  p_last_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.payment_webhook_events;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_provider is null or p_provider = '' then
    raise exception 'provider is required';
  end if;
  if p_provider_event_id is null or p_provider_event_id = '' then
    raise exception 'provider_event_id is required';
  end if;
  if p_expected_processing_attempt is null or p_expected_processing_attempt <= 0 then
    raise exception 'expected processing attempt must be a positive number';
  end if;

  update public.payment_webhook_events
  set processing_status = 'error',
      processing_started_at = null,
      last_error = left(p_last_error, 500)
  where provider = p_provider
    and provider_event_id = p_provider_event_id
    and processing_status = 'processing'
    and processing_attempts = p_expected_processing_attempt
  returning * into v_row;

  if v_row.id is not null then
    return jsonb_build_object('outcome', 'error_recorded', 'processing_status', v_row.processing_status, 'processing_attempts', v_row.processing_attempts);
  end if;

  select * into v_row from public.payment_webhook_events
  where provider = p_provider and provider_event_id = p_provider_event_id;

  if v_row.id is null then
    raise exception 'webhook event not found for provider % / event %', p_provider, p_provider_event_id;
  end if;

  if v_row.processing_status = 'error' and v_row.processing_attempts = p_expected_processing_attempt then
    return jsonb_build_object('outcome', 'already_error', 'processing_status', v_row.processing_status, 'processing_attempts', v_row.processing_attempts);
  end if;

  if v_row.processing_attempts <> p_expected_processing_attempt then
    return jsonb_build_object('outcome', 'lost_claim', 'processing_status', v_row.processing_status, 'processing_attempts', v_row.processing_attempts);
  end if;

  return jsonb_build_object('outcome', 'invalid_state', 'processing_status', v_row.processing_status, 'processing_attempts', v_row.processing_attempts);
end;
$$;

-- ------------------------------------------------------------
-- GRANTS -- service_role only, matching every existing payment RPC
-- (record_webhook_event and every function in
-- 20260801000004_payment_rpcs.sql). No client/public privilege change.
-- record_webhook_event itself is untouched by this migration -- its
-- existing insert-or-detect-duplicate contract and return shape
-- (webhook_event_id, is_duplicate) remain exactly as they are; the new
-- claim/complete/error functions are additive, called only after it.
-- ------------------------------------------------------------
revoke all on function public.claim_webhook_event_processing(text, text, integer) from public, anon, authenticated;
revoke all on function public.mark_webhook_event_processed(text, text, integer) from public, anon, authenticated;
revoke all on function public.mark_webhook_event_error(text, text, integer, text) from public, anon, authenticated;

grant execute on function public.claim_webhook_event_processing(text, text, integer) to service_role;
grant execute on function public.mark_webhook_event_processed(text, text, integer) to service_role;
grant execute on function public.mark_webhook_event_error(text, text, integer, text) to service_role;
