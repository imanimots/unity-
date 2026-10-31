import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Admin Control Centre -- AI R&D & Intelligence Human Evaluation Ledger
 * (E3).
 *
 * This module is the ONLY part of the Intelligence stack that touches
 * the database for anything beyond the read-only analytics/operational
 * sources E1/E2 already use. It is deliberately kept separate from
 * src/lib/admin/intelligence-service.ts -- that file's job is
 * deterministic generation of insights from Unity's own analytics; this
 * file's job is recording an admin's OPINION about a past insight
 * occurrence (identified by its stable `fingerprint`, never by raw
 * evidence or a live re-read of the insight).
 *
 * Critical invariant (E3 Section 20/39): nothing in this file is ever
 * imported by, or feeds data back into, getIntelligenceInsights(). An
 * evaluation can never change which insights are generated, their
 * priority/confidence/dataSufficiency, source health, or the homepage
 * summary -- it is a one-way write of admin feedback, read back only by
 * this same module for display/audit purposes.
 *
 * Non-goals, explicitly, per the E3 brief: no reinforcement learning, no
 * automatic model training, no automatic rule disabling, no external AI
 * call, no free-text admin notes (reason codes only), no 1-10 scoring.
 */

export const EVALUATION_VALUES = ['useful', 'not_useful', 'incorrect', 'needs_more_data', 'needs_investigation'] as const
export type IntelligenceEvaluationValue = (typeof EVALUATION_VALUES)[number]

/** Human-readable labels for the UI -- single source of truth, same convention as EVIDENCE_BASIS_LABEL in intelligence-service.ts. */
export const EVALUATION_LABEL: Record<IntelligenceEvaluationValue, string> = {
  useful: 'Useful',
  not_useful: 'Not useful',
  incorrect: 'Incorrect',
  needs_more_data: 'Needs more data',
  needs_investigation: 'Needs investigation',
}

/** Evaluation values that warrant a lightweight confirmation before submit (E3 Section 18) -- the more consequential-sounding judgments. */
export const EVALUATION_VALUES_REQUIRING_CONFIRMATION: ReadonlySet<IntelligenceEvaluationValue> = new Set(['incorrect', 'not_useful'])

export const REASON_CODES = ['NOT_ENOUGH_CONTEXT', 'WRONG_INTERPRETATION', 'STALE_SIGNAL', 'EXPECTED_BEHAVIOR', 'DUPLICATE_SIGNAL', 'OTHER'] as const
export type IntelligenceEvaluationReasonCode = (typeof REASON_CODES)[number]

export function isValidEvaluation(value: unknown): value is IntelligenceEvaluationValue {
  return typeof value === 'string' && (EVALUATION_VALUES as readonly string[]).includes(value)
}

export function isValidReasonCode(value: unknown): value is IntelligenceEvaluationReasonCode {
  return typeof value === 'string' && (REASON_CODES as readonly string[]).includes(value)
}

/** A fingerprint is always a 64-char lowercase hex SHA-256 digest -- see computeInsightFingerprint() in intelligence-service.ts. Never trust a client-supplied value that doesn't even match this shape. */
export function isValidFingerprintFormat(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

export interface IntelligenceEvaluationRecord {
  insightFingerprint: string
  fingerprintVersion: number
  ruleId: string
  evaluation: IntelligenceEvaluationValue
  reasonCode: IntelligenceEvaluationReasonCode | null
  createdAt: string
  updatedAt: string
}

/**
 * E3 Section 15: ONE batched query for every fingerprint currently
 * visible on the page -- never one query per insight. Scoped to the
 * CALLING ADMIN's own id only (never trusts a caller-supplied admin id
 * for reads either), so one admin's ratings can never be returned as
 * another admin's.
 */
export async function getEvaluationsForFingerprints(
  admin: SupabaseClient,
  adminUserId: string,
  fingerprints: string[]
): Promise<Map<string, IntelligenceEvaluationValue>> {
  const map = new Map<string, IntelligenceEvaluationValue>()
  if (fingerprints.length === 0) return map

  const { data, error } = await admin
    .from('admin_intelligence_evaluations')
    .select('insight_fingerprint, evaluation')
    .eq('admin_user_id', adminUserId)
    .in('insight_fingerprint', fingerprints)

  // Fail closed to "no evaluations known" rather than throwing -- a read
  // failure here must never break Intelligence rendering (E3 Section 31).
  if (error || !data) return map

  for (const row of data as Array<{ insight_fingerprint: string; evaluation: string }>) {
    if (isValidEvaluation(row.evaluation)) map.set(row.insight_fingerprint, row.evaluation)
  }
  return map
}

export interface RecordEvaluationInput {
  adminUserId: string
  insightFingerprint: string
  fingerprintVersion: number
  ruleId: string
  evaluation: IntelligenceEvaluationValue
  reasonCode?: IntelligenceEvaluationReasonCode | null
}

export type RecordEvaluationResult = { ok: true } | { ok: false; error: string }

/**
 * Persists one admin's current evaluation of one insight occurrence.
 * Delegates entirely to the `record_intelligence_evaluation` SECURITY
 * DEFINER RPC (see the E3 migration) -- this function does not insert
 * directly, so the upsert-plus-immutable-audit-history write happens in
 * one Postgres transaction (atomic: either both the current-state row
 * and the history row are written, or neither is). The RPC itself
 * enforces the UNIQUE (admin_user_id, insight_fingerprint) constraint,
 * so two rapid clicks from the same admin can race the database but can
 * never create two "current" rows (E3 Section 29/30).
 */
export async function recordIntelligenceEvaluation(admin: SupabaseClient, input: RecordEvaluationInput): Promise<RecordEvaluationResult> {
  const { error } = await admin.rpc('record_intelligence_evaluation', {
    p_admin_id: input.adminUserId,
    p_insight_fingerprint: input.insightFingerprint,
    p_fingerprint_version: input.fingerprintVersion,
    p_rule_id: input.ruleId,
    p_evaluation: input.evaluation,
    p_reason_code: input.reasonCode ?? null,
  })
  if (error) return { ok: false, error: 'Could not save this evaluation. Please try again.' }
  return { ok: true }
}

export interface RuleQualitySummaryRow {
  ruleId: string
  total: number
  useful: number
  notUseful: number
  incorrect: number
  needsMoreData: number
  needsInvestigation: number
}

/**
 * E3 Section 22/23: a small, privacy-safe, COUNT-only (never a
 * percentage) summary by rule id, so an admin can see which
 * deterministic rules are consistently rated useful vs. not -- without
 * this module ever drawing or implying a conclusion itself ("this rule
 * is bad"). Reads only already-aggregate evaluation rows (evaluation +
 * rule_id), never raw insight evidence or PII.
 */
export async function getRuleQualitySummary(admin: SupabaseClient): Promise<RuleQualitySummaryRow[]> {
  const { data, error } = await admin.from('admin_intelligence_evaluations').select('rule_id, evaluation')
  if (error || !data) return []

  const byRule = new Map<string, RuleQualitySummaryRow>()
  for (const row of data as Array<{ rule_id: string; evaluation: string }>) {
    if (!isValidEvaluation(row.evaluation)) continue
    const existing = byRule.get(row.rule_id) ?? {
      ruleId: row.rule_id, total: 0, useful: 0, notUseful: 0, incorrect: 0, needsMoreData: 0, needsInvestigation: 0,
    }
    existing.total += 1
    if (row.evaluation === 'useful') existing.useful += 1
    else if (row.evaluation === 'not_useful') existing.notUseful += 1
    else if (row.evaluation === 'incorrect') existing.incorrect += 1
    else if (row.evaluation === 'needs_more_data') existing.needsMoreData += 1
    else if (row.evaluation === 'needs_investigation') existing.needsInvestigation += 1
    byRule.set(row.rule_id, existing)
  }
  return [...byRule.values()].sort((a, b) => b.total - a.total || a.ruleId.localeCompare(b.ruleId))
}
