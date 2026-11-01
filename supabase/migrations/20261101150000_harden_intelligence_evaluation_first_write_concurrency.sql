-- ============================================================
-- E12: Intelligence evaluation first-write concurrency hardening
-- Phase: ADMIN-CONTROL-CENTRE-BATCH-E12-INTELLIGENCE-EVALUATION-FIRST-WRITE-CONCURRENCY-HARDENING
--
-- E4's SELECT ... FOR UPDATE correctly serializes concurrent writes
-- when the current row already exists, but it cannot lock an absent row.
-- Two concurrent first writes for the same (admin_user_id,
-- insight_fingerprint) can therefore both observe previous_evaluation
-- as NULL before ON CONFLICT serializes the current-state write.
--
-- Acquire a transaction-scoped advisory lock keyed to the complete
-- logical unique key before reading current state. hashtextextended()
-- is a deterministic non-cryptographic 64-bit hash. A theoretical hash
-- collision can only cause unnecessary cross-key serialization because
-- all data identity remains enforced by exact SQL predicates and the
-- table UNIQUE constraint.
-- ============================================================

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
  -- Serialize every write for the exact logical ledger key, including
  -- the first-ever write where no row exists yet. The lock is scoped to
  -- this transaction and releases automatically on commit/rollback.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_admin_id::text || ':' || p_insight_fingerprint,
      0
    )
  );

  -- Retain E4's existing-row lock as defense-in-depth.
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

revoke all on function public.record_intelligence_evaluation(uuid, text, integer, text, text, text)
  from public, anon, authenticated;
grant execute on function public.record_intelligence_evaluation(uuid, text, integer, text, text, text)
  to service_role;
