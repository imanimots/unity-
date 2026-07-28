-- ============================================================
-- Remove credit-score dependency (Phase 1 architecture change)
-- ============================================================
-- Unity's MVP explicitly excludes loans, credit building, credit
-- scoring, credit bureau reporting, and NCR registration workflows.
-- These two columns were the only credit-scoring plumbing in the
-- schema and are superseded by the Risk Engine
-- (see 20260720000002_risk_engine.sql).
-- Apply via: Supabase Dashboard → SQL Editor → Run
-- ============================================================

alter table public.listings
  drop column if exists requires_credit_score,
  drop column if exists min_credit_score;
