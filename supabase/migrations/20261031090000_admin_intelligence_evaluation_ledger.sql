-- ============================================================
-- Admin Control Centre -- AI R&D & Intelligence Human Evaluation
-- Ledger (E3)
-- ============================================================
-- E1/E2 (src/lib/admin/intelligence-service.ts) generate deterministic,
-- rule-based Intelligence insights from Unity's own already-verified
-- analytics -- read-only, no persistence. E3 adds the FIRST write
-- surface in the Intelligence stack: an authorized admin's own opinion
-- of one insight OCCURRENCE (useful / not_useful / incorrect /
-- needs_more_data / needs_investigation), identified by a stable,
-- deterministic, privacy-safe `insight_fingerprint` (a SHA-256 digest
-- over {ruleId, scope, trigger, evidence} -- see
-- computeInsightFingerprint() in intelligence-service.ts) rather than
-- by ruleId alone, because a rule fires repeatedly over time with
-- different evidence and feedback on one occurrence must not silently
-- attach to every future, unrelated firing of the same rule.
--
-- This is an EVALUATION record, not a business/enforcement record:
-- "incorrect" means "this Intelligence finding appears wrong", never
-- "the user/transaction involved is fraudulent/incorrect". Nothing here
-- references a user, booking, order, listing, or any other marketplace
-- entity -- only already-aggregate Intelligence metadata (rule id,
-- scope, fingerprint) that cannot carry PII in the first place. No raw
-- insight text (title/summary/rationale/recommendation) and no raw
-- evidence payload is ever persisted, per the E3 brief's explicit
-- minimization requirement.
--
-- Two tables, mirroring the established split elsewhere in this
-- codebase (admin_action_history vs. listing_history;
-- identity_verifications vs. its RPC-driven history -- see
-- 20260803000001_ownership_verification_schema.sql's own rationale
-- comment for why a single table cannot cleanly serve both jobs):
--   - admin_intelligence_evaluations: MUTABLE current-state, one row
--     per (admin_user_id, insight_fingerprint) via UNIQUE constraint +
--     upsert. An admin can change their rating of the same occurrence.
--   - admin_intelligence_evaluation_history: IMMUTABLE append-only
--     audit trail (trigger-enforced via the existing
--     public.prevent_row_mutation(), same as every other history table
--     in this codebase), recording every create/change with the
--     previous and new evaluation value.
--
-- Both tables are written ONLY by the record_intelligence_evaluation()
-- SECURITY DEFINER RPC below, in one Postgres function call --
-- transactional by default, so the current-state upsert and the audit
-- insert always succeed or fail together. Neither table has a client
-- INSERT/UPDATE/DELETE policy at all; the calling API route
-- independently re-verifies the caller is an admin (requireAdmin())
-- before ever reaching this RPC, exactly as every other Admin mutation
-- RPC in this codebase does.
--
-- Deliberately out of scope for E3 (see the phase brief): no
-- reinforcement learning, no automatic model training, no automatic
-- rule disabling/threshold change, no free-text admin notes (reason
-- codes only, from a fixed enum), no 1-10 scoring, no retention policy
-- beyond "these are internal admin product-quality records containing
-- no marketplace user identity, so normal customer-erasure does not
-- apply to them".
-- ============================================================

create table if not exists public.admin_intelligence_evaluations (
  id                   uuid primary key default gen_random_uuid(),
  insight_fingerprint  text not null check (insight_fingerprint ~ '^[0-9a-f]{64}$'),
  fingerprint_version  integer not null default 1,
  rule_id              text not null,
  evaluation           text not null check (evaluation in ('useful', 'not_useful', 'incorrect', 'needs_more_data', 'needs_investigation')),
  reason_code          text check (reason_code is null or reason_code in ('NOT_ENOUGH_CONTEXT', 'WRONG_INTERPRETATION', 'STALE_SIGNAL', 'EXPECTED_BEHAVIOR', 'DUPLICATE_SIGNAL', 'OTHER')),
  admin_user_id        uuid not null references public.profiles(id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint admin_intelligence_evaluations_admin_fingerprint_uniq unique (admin_user_id, insight_fingerprint)
);

create index if not exists admin_intelligence_evaluations_rule_id_idx on public.admin_intelligence_evaluations(rule_id);

alter table public.admin_intelligence_evaluations enable row level security;

create policy "admin_intelligence_evaluations: admin read" on public.admin_intelligence_evaluations
  for select using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));

-- No client INSERT/UPDATE/DELETE policy -- rows are written only by
-- record_intelligence_evaluation() below, via the service-role client.

create table if not exists public.admin_intelligence_evaluation_history (
  id                   uuid primary key default gen_random_uuid(),
  insight_fingerprint  text not null check (insight_fingerprint ~ '^[0-9a-f]{64}$'),
  fingerprint_version  integer not null default 1,
  rule_id              text not null,
  admin_user_id        uuid not null references public.profiles(id),
  previous_evaluation  text check (previous_evaluation is null or previous_evaluation in ('useful', 'not_useful', 'incorrect', 'needs_more_data', 'needs_investigation')),
  new_evaluation       text not null check (new_evaluation in ('useful', 'not_useful', 'incorrect', 'needs_more_data', 'needs_investigation')),
  reason_code          text check (reason_code is null or reason_code in ('NOT_ENOUGH_CONTEXT', 'WRONG_INTERPRETATION', 'STALE_SIGNAL', 'EXPECTED_BEHAVIOR', 'DUPLICATE_SIGNAL', 'OTHER')),
  created_at           timestamptz not null default now()
);

create index if not exists admin_intelligence_evaluation_history_fingerprint_idx
  on public.admin_intelligence_evaluation_history(insight_fingerprint, admin_user_id, created_at);

alter table public.admin_intelligence_evaluation_history enable row level security;

create policy "admin_intelligence_evaluation_history: admin read" on public.admin_intelligence_evaluation_history
  for select using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));

-- No client INSERT/UPDATE/DELETE policy here either -- only the RPC
-- below writes rows, and the immutability trigger below additionally
-- refuses any UPDATE/DELETE regardless of who attempts it.
drop trigger if exists admin_intelligence_evaluation_history_immutable on public.admin_intelligence_evaluation_history;
create trigger admin_intelligence_evaluation_history_immutable
  before update or delete on public.admin_intelligence_evaluation_history
  for each row execute function public.prevent_row_mutation();

-- ─────────────────────────────────────────
-- record_intelligence_evaluation -- the single write path for both
-- tables above. SECURITY DEFINER, refuses to run for anyone but
-- service_role (revoked below), takes the acting admin's id as an
-- explicit parameter (a service-role session has no auth.uid()) --
-- same trust model as every admin-mutation RPC in this codebase. The
-- calling API route (POST /api/admin/intelligence/evaluations)
-- independently re-verifies the caller is a real, authenticated admin
-- AND that (rule_id, insight_fingerprint) matches a currently-generated
-- Intelligence insight before ever calling this -- this RPC does not
-- re-validate that pairing itself (it has no access to
-- getIntelligenceInsights()'s in-memory result), only the shape of its
-- own inputs via the CHECK constraints above.
--
-- Upserts the current-state row (one per admin+fingerprint, via the
-- UNIQUE constraint + ON CONFLICT -- idempotent: resubmitting the same
-- evaluation is a no-op in effect, and changing it safely replaces the
-- current row rather than creating a duplicate) and inserts one
-- immutable history row recording the transition, in the same
-- transaction -- both succeed or both fail together.
-- ─────────────────────────────────────────
create or replace function public.record_intelligence_evaluation(
  p_admin_id uuid,
  p_insight_fingerprint text,
  p_fingerprint_version integer,
  p_rule_id text,
  p_evaluation text,
  p_reason_code text default null
) returns public.admin_intelligence_evaluations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_previous text;
  v_row public.admin_intelligence_evaluations;
begin
  -- E4: locks the existing row (if any) before reading it, so two
  -- genuinely concurrent calls for the SAME (admin_user_id,
  -- insight_fingerprint) cannot both read the same stale "previous"
  -- value. Without this lock, under READ COMMITTED, two racing
  -- transactions could both SELECT the same pre-change value before
  -- either commits; the UNIQUE constraint still keeps the CURRENT-STATE
  -- row correct, but whichever call is serialized second would write a
  -- history row claiming the wrong "previous_evaluation", misrepresenting
  -- the real transition sequence. With FOR UPDATE, the second call
  -- blocks until the first commits, then re-reads the now-committed
  -- value -- so the audit trail always reflects the actual serialized
  -- order of changes, not just the current-state table.
  select evaluation into v_previous
  from public.admin_intelligence_evaluations
  where admin_user_id = p_admin_id and insight_fingerprint = p_insight_fingerprint
  for update;

  insert into public.admin_intelligence_evaluations (
    insight_fingerprint, fingerprint_version, rule_id, evaluation, reason_code, admin_user_id, updated_at
  ) values (
    p_insight_fingerprint, p_fingerprint_version, p_rule_id, p_evaluation, p_reason_code, p_admin_id, now()
  )
  on conflict (admin_user_id, insight_fingerprint) do update set
    evaluation = excluded.evaluation,
    reason_code = excluded.reason_code,
    fingerprint_version = excluded.fingerprint_version,
    rule_id = excluded.rule_id,
    updated_at = now()
  returning * into v_row;

  insert into public.admin_intelligence_evaluation_history (
    insight_fingerprint, fingerprint_version, rule_id, admin_user_id, previous_evaluation, new_evaluation, reason_code
  ) values (
    p_insight_fingerprint, p_fingerprint_version, p_rule_id, p_admin_id, v_previous, p_evaluation, p_reason_code
  );

  return v_row;
end;
$$;

revoke all on function public.record_intelligence_evaluation(uuid, text, integer, text, text, text) from public, anon, authenticated;
grant execute on function public.record_intelligence_evaluation(uuid, text, integer, text, text, text) to service_role;
