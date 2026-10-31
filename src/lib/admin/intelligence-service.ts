import type { SupabaseClient } from '@supabase/supabase-js'
import {
  getMarketplaceOverview,
  getSupplyAnalytics,
  getDemandAnalytics,
  getTransactionAnalytics,
  getTrustAnalytics,
  getGrowthAnalytics,
  getBehaviorAnalytics,
  getSupportAnalytics,
  type PeriodComparison,
} from '@/lib/admin/analytics-service'
import { listOperationalExceptions } from '@/lib/admin/exceptions-service'

/**
 * Admin Control Centre -- AI R&D & Intelligence foundation (E1).
 *
 * This is a RECOMMENDATION-ONLY, read-only, deterministic/rule-based
 * reasoning layer over Unity's own already-verified D1/D2/D3 analytics
 * (src/lib/admin/analytics-service.ts) and operational signals
 * (src/lib/admin/exceptions-service.ts, Support, and the Admin Overview
 * RPC's own established all-system work-queue fields). It never calls
 * an external AI provider, never sends Unity data outside Unity, never
 * mutates anything, and never exposes an action that performs a
 * business operation (ban/suspend/approve/refund/pay/etc.) -- every
 * insight is advisory text plus, optionally, a plain navigation link to
 * an existing Admin page.
 *
 * Every insight explicitly carries `scope`: 'real-data' (built only
 * from confirmed-real, positive-proof-filtered population, per D3's
 * canonical src/lib/admin/data-scope.ts contract) or
 * 'operational-all-system' (a legitimate all-system work-queue signal,
 * e.g. Support/KYC backlog, that intentionally includes test/unknown
 * records because an admin/agent must action every one of them
 * regardless of classification -- the same distinction D3-F's own
 * review established for these exact surfaces). No insight ever mixes
 * the two numerically.
 *
 * Current production reality (explicit, not glossed over): confirmed
 * Real Data volume is still small, and most D2 behavioral "started"
 * events have no listing anchor and are therefore always classified
 * 'unknown' under strict Real Data filtering (see
 * `buildConversionInsight`'s own comment) -- so most rule families
 * below will correctly produce a data-quality finding, not a
 * fabricated business insight, until more confirmed-real volume and
 * richer event instrumentation exist. That is the correct behavior,
 * not a bug.
 */

// ============================================================
// Types
// ============================================================

export type IntelligenceCategory = 'growth' | 'marketplace' | 'demand' | 'supply' | 'conversion' | 'trust' | 'finance' | 'operations' | 'data-quality'
export type IntelligenceInsightType = 'opportunity' | 'risk' | 'watch' | 'informational'
export type IntelligencePriority = 'high' | 'medium' | 'low'
export type IntelligenceConfidence = 'high' | 'medium' | 'low'
export type IntelligenceDataSufficiency = 'sufficient' | 'limited' | 'insufficient'
export type IntelligenceScope = 'real-data' | 'operational-all-system'

export interface IntelligenceEvidence {
  label: string
  value: string | number
  context?: string
}

/**
 * E2: structured "why did this fire" explainability for a business rule.
 * Optional -- a purely structural/narrative data-quality finding (e.g. the
 * disputes caveat) has no single runtime comparison to report and may omit
 * `operator`/`observedValue`/`thresholdValue`/`comparisonValue`, but every
 * insight still carries a `metric` name and the stable `ruleId` at the top
 * level (see `IntelligenceInsight.ruleId`) identifies which rule produced it.
 */
export interface IntelligenceTrigger {
  metric: string
  operator?: string
  observedValue?: number | string
  thresholdValue?: number | string
  comparisonValue?: number | string
}

export interface IntelligenceInsight {
  id: string
  /**
   * E2: stable, human-readable, deterministic rule identifier (see
   * RULE_IDS below) -- NOT a database id or UUID. Identical inputs always
   * produce the same ruleId for the same rule family, so admins/tests can
   * reference "this exact rule" independent of `id` (which is only a
   * React-key-style per-call counter, see `nextId`).
   */
  ruleId: string
  category: IntelligenceCategory
  type: IntelligenceInsightType
  priority: IntelligencePriority
  title: string
  summary: string
  /** What was compared/observed and why it matters -- never a bare "AI detected a risk" style claim. */
  rationale: string
  evidence: IntelligenceEvidence[]
  /** E2: structured trigger detail -- see IntelligenceTrigger. */
  trigger?: IntelligenceTrigger
  /** Advisory text only. Never describes or implies an automated action -- see this module's own header comment. */
  recommendation: string
  confidence: IntelligenceConfidence
  dataSufficiency: IntelligenceDataSufficiency
  scope: IntelligenceScope
  /**
   * E2: specific, rule-tailored caveats (e.g. "small sample",
   * "operational all-system scope") -- deliberately NOT a boilerplate
   * disclaimer repeated on every insight; empty when no caveat applies
   * beyond what confidence/dataSufficiency already convey.
   */
  limitations: string[]
  generatedAt: string
  /**
   * E2: honest freshness disclosure -- `generatedAt` duplicates the field
   * above for convenience on this object, and `sourceWindow` names the
   * known analytics period this insight was computed over. Never a
   * fabricated per-table "last updated N seconds ago" timestamp.
   */
  freshness: { generatedAt: string; sourceWindow: string }
  /** Plain navigation to an existing Admin page -- never an action/mutation endpoint. */
  actionHref?: string
  actionLabel?: string
}

/**
 * E2: every `buildXInsights` rule function below constructs this shape
 * (everything except `freshness`) -- `attachFreshness()` is applied once,
 * centrally, in `getIntelligenceInsights()` rather than threading the
 * same `{generatedAt, sourceWindow}` literal through every individual
 * call site.
 */
type DraftInsight = Omit<IntelligenceInsight, 'freshness'>

export interface IntelligenceSummary {
  totalInsights: number
  highPriority: number
  opportunities: number
  risksAndWatch: number
  dataQualityLimitations: number
  /**
   * E1-F1: scope-aware breakdown so a consumer (the homepage card, in
   * particular) can show Real Data and Operational-all-system counts
   * separately rather than one scope-blind total that could read as a
   * pure Real Data business KPI. These do not replace the top-level
   * fields above (kept for backward compatibility) -- they partition
   * the same underlying insight list by `scope`.
   */
  realData: { highPriority: number; opportunities: number }
  operational: { highPriority: number }
}

/**
 * E2: one row per Intelligence input source, independent of whether it
 * produced any insight this cycle -- the diagnostic surface an admin uses
 * to answer "was anything unavailable, and what does that affect?".
 * `status` only ever reflects the source's own `SourceOutcome.ok`; never a
 * raw error, Postgres message, or stack trace. `usedBy` lists the stable
 * rule IDs (RULE_IDS) that read this source, so a degraded row tells an
 * admin exactly which rule families may be incomplete -- derived
 * statically from SOURCE_USED_BY, not recomputed per request.
 */
export interface IntelligenceSourceStatus {
  source: string
  label: string
  status: 'available' | 'degraded'
  scope: IntelligenceScope
  usedBy: string[]
}

export interface IntelligenceResult {
  generatedAt: string
  period: '30d'
  summary: IntelligenceSummary
  insights: IntelligenceInsight[]
  /** E2: per-source availability diagnostics -- see IntelligenceSourceStatus. */
  sourceHealth: IntelligenceSourceStatus[]
}

// ============================================================
// Centralized, named, tunable thresholds.
//
// None of these are derived from a statistical model -- there isn't
// enough confirmed-real volume yet to fit one. Each is a conservative,
// documented floor chosen so a rule stays silent (reports insufficient
// data) rather than editorializing on a handful of rows. Revisit once
// real volume grows.
// ============================================================

const THRESHOLDS = {
  /** Below this many confirmed-real profiles, percentage-based trend/growth comparisons are too noisy to be meaningful. */
  MIN_REAL_PROFILES_FOR_TREND: 20,
  /** A period-over-period comparison needs at least this many in the PREVIOUS window, or a swing from e.g. 1->2 would misleadingly read as "+100%". */
  MIN_PREVIOUS_FOR_TREND: 5,
  /** A period-over-period percentage swing at or above this magnitude is worth a human look; below it, treated as ordinary variance. */
  GROWTH_SWING_PCT: 25,
  /** Below this many confirmed-real active listings, supply/demand and category-concentration insights are suppressed as noise. */
  MIN_REAL_LISTINGS_FOR_SUPPLY_SIGNAL: 10,
  /** Looking For demand at least this multiple of real active listings suggests supply pressure worth noting. */
  DEMAND_SUPPLY_RATIO_WATCH: 2,
  /** A single listing category holding at least this share of real active listings is flagged as concentration worth noting. */
  CATEGORY_CONCENTRATION_SHARE: 0.5,
  /** Below this many confirmed-real restricted+suspended accounts, no trust pattern insight is generated (too small a cohort to generalize from, and small cohorts risk identifying individuals -- Section 9). */
  RESTRICTION_WATCH_COUNT: 3,
  /** Below this many confirmed-real profiles with any KYC status recorded, no KYC-mix informational insight is generated. */
  MIN_REAL_KYC_ROWS_FOR_INFO: 5,
  /** Below this many confirmed-real completed transactions (bookings+orders) in the period, no review-collection informational insight is generated. */
  MIN_REAL_TRANSACTIONS_FOR_REVIEW_RATIO: 5,
  /** An operational all-system backlog (Support/KYC/ownership/moderation/exceptions/email-retry queue depth) at or above this count is a watch item. */
  OPERATIONAL_BACKLOG_WATCH_COUNT: 10,
  /** ...and at or above this count is escalated to a risk (high priority). */
  OPERATIONAL_BACKLOG_HIGH_COUNT: 30,
  /** E1-F1: at or above this many unavailable input sources (of 10 total), the "Intelligence inputs are partially unavailable" finding is escalated to high priority -- a systemic read problem, not a single transient hiccup. */
  DEGRADED_SOURCES_HIGH_COUNT: 3,
} as const

const PERIOD = '30d' as const
/** E2: honest, known evidence window label -- never a fabricated per-table refresh timestamp. */
const SOURCE_WINDOW_LABEL = 'Last 30 days'

// ============================================================
// E2: stable rule IDs and a lightweight rule registry.
//
// Deterministic, human-readable, never a UUID or DB id -- identical
// inputs always produce the same ruleId for the same rule family. The
// registry below is metadata only (category/scope/description/threshold
// references) for auditability and testing; it intentionally does NOT
// drive control flow -- each `buildXInsights` function below remains the
// single source of truth for when/how a rule fires, exactly as E1
// established. `Record<RuleId, RuleMeta>` forces this object to list
// every rule id exactly once (TypeScript errors on a missing or
// duplicated key), which is itself a standing guard against two rule
// families silently sharing an id.
// ============================================================

export const RULE_IDS = {
  DATA_PARTIAL_SOURCE_FAILURE: 'DATA_PARTIAL_SOURCE_FAILURE',
  DATA_INSUFFICIENT_REAL_PROFILES: 'DATA_INSUFFICIENT_REAL_PROFILES',
  DATA_NO_EVENT_DATA: 'DATA_NO_EVENT_DATA',
  DATA_DISPUTES_UNVERIFIED: 'DATA_DISPUTES_UNVERIFIED',
  DEMAND_SUPPLY_IMBALANCE: 'DEMAND_SUPPLY_IMBALANCE',
  SUPPLY_CATEGORY_CONCENTRATION: 'SUPPLY_CATEGORY_CONCENTRATION',
  GROWTH_NEW_USERS_UP: 'GROWTH_NEW_USERS_UP',
  GROWTH_NEW_USERS_DOWN: 'GROWTH_NEW_USERS_DOWN',
  GROWTH_NEW_MERCHANTS_UP: 'GROWTH_NEW_MERCHANTS_UP',
  GROWTH_NEW_MERCHANTS_DOWN: 'GROWTH_NEW_MERCHANTS_DOWN',
  GROWTH_NEW_REAL_LISTINGS_UP: 'GROWTH_NEW_REAL_LISTINGS_UP',
  GROWTH_NEW_REAL_LISTINGS_DOWN: 'GROWTH_NEW_REAL_LISTINGS_DOWN',
  GROWTH_NEW_BOOKINGS_UP: 'GROWTH_NEW_BOOKINGS_UP',
  GROWTH_NEW_BOOKINGS_DOWN: 'GROWTH_NEW_BOOKINGS_DOWN',
  GROWTH_NEW_ORDERS_UP: 'GROWTH_NEW_ORDERS_UP',
  GROWTH_NEW_ORDERS_DOWN: 'GROWTH_NEW_ORDERS_DOWN',
  CONVERSION_NOT_COMPUTABLE: 'CONVERSION_NOT_COMPUTABLE',
  TRUST_ACCOUNT_RESTRICTIONS: 'TRUST_ACCOUNT_RESTRICTIONS',
  TRUST_KYC_STATUS_MIX: 'TRUST_KYC_STATUS_MIX',
  TRUST_REVIEWS_SPARSE: 'TRUST_REVIEWS_SPARSE',
  OPERATIONS_SUPPORT_BACKLOG: 'OPERATIONS_SUPPORT_BACKLOG',
  OPERATIONS_KYC_REVIEW_BACKLOG: 'OPERATIONS_KYC_REVIEW_BACKLOG',
  OPERATIONS_OWNERSHIP_REVIEW_BACKLOG: 'OPERATIONS_OWNERSHIP_REVIEW_BACKLOG',
  OPERATIONS_LISTING_MODERATION_BACKLOG: 'OPERATIONS_LISTING_MODERATION_BACKLOG',
  OPERATIONS_FAILED_FINANCIAL_WORKFLOW_BACKLOG: 'OPERATIONS_FAILED_FINANCIAL_WORKFLOW_BACKLOG',
  OPERATIONS_EMAIL_FAILURE_BACKLOG: 'OPERATIONS_EMAIL_FAILURE_BACKLOG',
  OPERATIONS_EXCEPTIONS_BACKLOG: 'OPERATIONS_EXCEPTIONS_BACKLOG',
} as const

export type RuleId = (typeof RULE_IDS)[keyof typeof RULE_IDS]

interface RuleMeta {
  category: IntelligenceCategory
  scope: IntelligenceScope
  description: string
  thresholdRefs?: Array<keyof typeof THRESHOLDS>
}

export const RULE_REGISTRY: Record<RuleId, RuleMeta> = {
  DATA_PARTIAL_SOURCE_FAILURE: { category: 'data-quality', scope: 'real-data', description: 'One or more Intelligence input sources could not be read this cycle.', thresholdRefs: ['DEGRADED_SOURCES_HIGH_COUNT'] },
  DATA_INSUFFICIENT_REAL_PROFILES: { category: 'data-quality', scope: 'real-data', description: 'Confirmed-real user base is below the floor needed for meaningful trend comparisons.', thresholdRefs: ['MIN_REAL_PROFILES_FOR_TREND'] },
  DATA_NO_EVENT_DATA: { category: 'data-quality', scope: 'real-data', description: 'No first-party behavioral event data recorded yet.' },
  DATA_DISPUTES_UNVERIFIED: { category: 'data-quality', scope: 'real-data', description: 'Dispute counts cannot yet be reliably restricted to confirmed-real records.' },
  DEMAND_SUPPLY_IMBALANCE: { category: 'demand', scope: 'real-data', description: 'Looking For demand volume outpaces real active listing supply.', thresholdRefs: ['MIN_REAL_LISTINGS_FOR_SUPPLY_SIGNAL', 'DEMAND_SUPPLY_RATIO_WATCH'] },
  SUPPLY_CATEGORY_CONCENTRATION: { category: 'supply', scope: 'real-data', description: 'Real active listing supply is concentrated in a single category.', thresholdRefs: ['CATEGORY_CONCENTRATION_SHARE'] },
  GROWTH_NEW_USERS_UP: { category: 'growth', scope: 'real-data', description: 'New confirmed-real users rose period-over-period.', thresholdRefs: ['MIN_PREVIOUS_FOR_TREND', 'GROWTH_SWING_PCT'] },
  GROWTH_NEW_USERS_DOWN: { category: 'growth', scope: 'real-data', description: 'New confirmed-real users fell period-over-period.', thresholdRefs: ['MIN_PREVIOUS_FOR_TREND', 'GROWTH_SWING_PCT'] },
  GROWTH_NEW_MERCHANTS_UP: { category: 'growth', scope: 'real-data', description: 'New confirmed-real merchants rose period-over-period.', thresholdRefs: ['MIN_PREVIOUS_FOR_TREND', 'GROWTH_SWING_PCT'] },
  GROWTH_NEW_MERCHANTS_DOWN: { category: 'growth', scope: 'real-data', description: 'New confirmed-real merchants fell period-over-period.', thresholdRefs: ['MIN_PREVIOUS_FOR_TREND', 'GROWTH_SWING_PCT'] },
  GROWTH_NEW_REAL_LISTINGS_UP: { category: 'growth', scope: 'real-data', description: 'New confirmed-real listings rose period-over-period.', thresholdRefs: ['MIN_PREVIOUS_FOR_TREND', 'GROWTH_SWING_PCT'] },
  GROWTH_NEW_REAL_LISTINGS_DOWN: { category: 'growth', scope: 'real-data', description: 'New confirmed-real listings fell period-over-period.', thresholdRefs: ['MIN_PREVIOUS_FOR_TREND', 'GROWTH_SWING_PCT'] },
  GROWTH_NEW_BOOKINGS_UP: { category: 'growth', scope: 'real-data', description: 'New confirmed-real bookings rose period-over-period.', thresholdRefs: ['MIN_PREVIOUS_FOR_TREND', 'GROWTH_SWING_PCT'] },
  GROWTH_NEW_BOOKINGS_DOWN: { category: 'growth', scope: 'real-data', description: 'New confirmed-real bookings fell period-over-period.', thresholdRefs: ['MIN_PREVIOUS_FOR_TREND', 'GROWTH_SWING_PCT'] },
  GROWTH_NEW_ORDERS_UP: { category: 'growth', scope: 'real-data', description: 'New confirmed-real orders rose period-over-period.', thresholdRefs: ['MIN_PREVIOUS_FOR_TREND', 'GROWTH_SWING_PCT'] },
  GROWTH_NEW_ORDERS_DOWN: { category: 'growth', scope: 'real-data', description: 'New confirmed-real orders fell period-over-period.', thresholdRefs: ['MIN_PREVIOUS_FOR_TREND', 'GROWTH_SWING_PCT'] },
  CONVERSION_NOT_COMPUTABLE: { category: 'conversion', scope: 'real-data', description: 'Funnel conversion rate cannot be computed from confirmed Real Data under current instrumentation.' },
  TRUST_ACCOUNT_RESTRICTIONS: { category: 'trust', scope: 'real-data', description: 'Confirmed-real accounts are currently restricted or suspended.', thresholdRefs: ['RESTRICTION_WATCH_COUNT'] },
  TRUST_KYC_STATUS_MIX: { category: 'trust', scope: 'real-data', description: 'Confirmed-real KYC status mix baseline.', thresholdRefs: ['MIN_REAL_KYC_ROWS_FOR_INFO'] },
  TRUST_REVIEWS_SPARSE: { category: 'trust', scope: 'real-data', description: 'Published reviews are sparse relative to completed real transactions.', thresholdRefs: ['MIN_REAL_TRANSACTIONS_FOR_REVIEW_RATIO'] },
  OPERATIONS_SUPPORT_BACKLOG: { category: 'operations', scope: 'operational-all-system', description: 'Open Support case backlog.', thresholdRefs: ['OPERATIONAL_BACKLOG_WATCH_COUNT', 'OPERATIONAL_BACKLOG_HIGH_COUNT'] },
  OPERATIONS_KYC_REVIEW_BACKLOG: { category: 'operations', scope: 'operational-all-system', description: 'Pending KYC review backlog.', thresholdRefs: ['OPERATIONAL_BACKLOG_WATCH_COUNT', 'OPERATIONAL_BACKLOG_HIGH_COUNT'] },
  OPERATIONS_OWNERSHIP_REVIEW_BACKLOG: { category: 'operations', scope: 'operational-all-system', description: 'Pending ownership verification backlog.', thresholdRefs: ['OPERATIONAL_BACKLOG_WATCH_COUNT', 'OPERATIONAL_BACKLOG_HIGH_COUNT'] },
  OPERATIONS_LISTING_MODERATION_BACKLOG: { category: 'operations', scope: 'operational-all-system', description: 'Pending listing moderation backlog.', thresholdRefs: ['OPERATIONAL_BACKLOG_WATCH_COUNT', 'OPERATIONAL_BACKLOG_HIGH_COUNT'] },
  OPERATIONS_FAILED_FINANCIAL_WORKFLOW_BACKLOG: { category: 'operations', scope: 'operational-all-system', description: 'Failed financial workflow backlog.', thresholdRefs: ['OPERATIONAL_BACKLOG_WATCH_COUNT', 'OPERATIONAL_BACKLOG_HIGH_COUNT'] },
  OPERATIONS_EMAIL_FAILURE_BACKLOG: { category: 'operations', scope: 'operational-all-system', description: 'Retryable email failure backlog.', thresholdRefs: ['OPERATIONAL_BACKLOG_WATCH_COUNT', 'OPERATIONAL_BACKLOG_HIGH_COUNT'] },
  OPERATIONS_EXCEPTIONS_BACKLOG: { category: 'operations', scope: 'operational-all-system', description: 'Unresolved Exceptions queue backlog.', thresholdRefs: ['OPERATIONAL_BACKLOG_WATCH_COUNT', 'OPERATIONAL_BACKLOG_HIGH_COUNT'] },
}

// ============================================================
// Small helpers
// ============================================================

let insightCounter = 0
function nextId(prefix: string): string {
  insightCounter += 1
  return `${prefix}-${insightCounter}`
}

/**
 * E1-F1 failure isolation: wraps one source read so a rejection can
 * never propagate into (or reject) the combined Promise.all in
 * getIntelligenceInsights(). `ok: false` is tracked explicitly and
 * carries NO data -- callers must never substitute a zero/empty value
 * and treat it as a genuine observation (that would silently turn
 * "source unavailable" into "observed zero", which is analytically
 * dishonest). Every `buildXInsights` function below checks `.ok`
 * itself and skips (or partially skips) whatever specifically depends
 * on a failed source, rather than receiving a fabricated fallback.
 */
interface SourceOutcome<T> {
  ok: boolean
  data: T | null
}

async function loadSource<T>(promise: Promise<T>): Promise<SourceOutcome<T>> {
  try {
    const data = await promise
    return { ok: true, data }
  } catch {
    return { ok: false, data: null }
  }
}

/** Human-readable, implementation-detail-free labels for the degraded-source disclosure -- never a raw table name or error message. */
const SOURCE_LABELS = {
  marketplace: 'Marketplace analytics',
  supply: 'Supply analytics',
  demand: 'Demand analytics',
  transactions: 'Transaction analytics',
  trust: 'Trust analytics',
  growth: 'Growth analytics',
  behavior: 'Behavior analytics',
  support: 'Support analytics',
  overviewStats: 'Operational overview stats',
  exceptions: 'Exceptions queue',
} as const

type SourceKey = keyof typeof SOURCE_LABELS

/** E2 source-health diagnostics: which scope each source feeds (matches the scope every insight it produces carries). */
const SOURCE_SCOPE: Record<SourceKey, IntelligenceScope> = {
  marketplace: 'real-data',
  supply: 'real-data',
  demand: 'real-data',
  transactions: 'real-data',
  trust: 'real-data',
  growth: 'real-data',
  behavior: 'real-data',
  support: 'operational-all-system',
  overviewStats: 'operational-all-system',
  exceptions: 'operational-all-system',
}

/**
 * E2 source-health diagnostics: the stable rule IDs that read each
 * source, derived statically from each `buildXInsights` function's own
 * parameter list below -- so a degraded row in `sourceHealth` tells an
 * admin exactly which rule families may be incomplete this cycle.
 */
const SOURCE_USED_BY: Record<SourceKey, RuleId[]> = {
  marketplace: [RULE_IDS.DATA_INSUFFICIENT_REAL_PROFILES, RULE_IDS.DEMAND_SUPPLY_IMBALANCE, RULE_IDS.SUPPLY_CATEGORY_CONCENTRATION],
  supply: [RULE_IDS.DEMAND_SUPPLY_IMBALANCE, RULE_IDS.SUPPLY_CATEGORY_CONCENTRATION],
  demand: [RULE_IDS.DEMAND_SUPPLY_IMBALANCE, RULE_IDS.SUPPLY_CATEGORY_CONCENTRATION],
  transactions: [RULE_IDS.TRUST_REVIEWS_SPARSE],
  trust: [RULE_IDS.TRUST_ACCOUNT_RESTRICTIONS, RULE_IDS.TRUST_KYC_STATUS_MIX, RULE_IDS.TRUST_REVIEWS_SPARSE],
  growth: [
    RULE_IDS.GROWTH_NEW_USERS_UP, RULE_IDS.GROWTH_NEW_USERS_DOWN,
    RULE_IDS.GROWTH_NEW_MERCHANTS_UP, RULE_IDS.GROWTH_NEW_MERCHANTS_DOWN,
    RULE_IDS.GROWTH_NEW_REAL_LISTINGS_UP, RULE_IDS.GROWTH_NEW_REAL_LISTINGS_DOWN,
    RULE_IDS.GROWTH_NEW_BOOKINGS_UP, RULE_IDS.GROWTH_NEW_BOOKINGS_DOWN,
    RULE_IDS.GROWTH_NEW_ORDERS_UP, RULE_IDS.GROWTH_NEW_ORDERS_DOWN,
  ],
  behavior: [RULE_IDS.DATA_NO_EVENT_DATA, RULE_IDS.CONVERSION_NOT_COMPUTABLE],
  support: [RULE_IDS.OPERATIONS_SUPPORT_BACKLOG],
  overviewStats: [
    RULE_IDS.OPERATIONS_KYC_REVIEW_BACKLOG, RULE_IDS.OPERATIONS_OWNERSHIP_REVIEW_BACKLOG,
    RULE_IDS.OPERATIONS_LISTING_MODERATION_BACKLOG, RULE_IDS.OPERATIONS_FAILED_FINANCIAL_WORKFLOW_BACKLOG,
    RULE_IDS.OPERATIONS_EMAIL_FAILURE_BACKLOG,
  ],
  exceptions: [RULE_IDS.OPERATIONS_EXCEPTIONS_BACKLOG],
}

/**
 * E1-F1 priority/confidence coherence: a non-data-quality Real Data
 * business insight (opportunity/risk/watch) must not carry
 * priority='high' unless its own evidence is both confidently and
 * sufficiently assessed -- otherwise a thin sample's raw percentage
 * swing could out-rank a well-supported finding (the independently
 * confirmed previous=5/current=8/+60% case). Applied as one universal
 * post-processing pass rather than a per-rule special case, so it
 * covers every current and future business rule automatically.
 * Deliberately exempt: 'data-quality' insights (a system-availability
 * finding can legitimately be high priority precisely because business
 * data is thin) and 'operational-all-system' insights (an operational
 * queue's own count is exact regardless of Real Data sample size).
 */
function clampBusinessPriority(insight: IntelligenceInsight): IntelligenceInsight {
  const isBusinessRealDataInsight = insight.scope === 'real-data' && insight.category !== 'data-quality' && insight.type !== 'informational'
  if (isBusinessRealDataInsight && insight.priority === 'high' && (insight.dataSufficiency !== 'sufficient' || insight.confidence === 'low')) {
    return { ...insight, priority: 'medium' }
  }
  return insight
}

/**
 * E2 freshness: a single, honest post-processing pass rather than
 * threading the same `{generatedAt, sourceWindow}` literal through every
 * one of the ~15 insight-construction call sites below. `sourceWindow`
 * names the known analytics period (THRESHOLDS/PERIOD-driven); never a
 * fabricated "refreshed Ns ago" style timestamp this module doesn't
 * actually have.
 */
function attachFreshness(insight: DraftInsight): IntelligenceInsight {
  return { ...insight, freshness: { generatedAt: insight.generatedAt, sourceWindow: SOURCE_WINDOW_LABEL } }
}

function pct(from: number, to: number): number {
  if (from === 0) return to === 0 ? 0 : Infinity
  return ((to - from) / from) * 100
}

/**
 * Generic period-over-period trend rule, reused for every Growth metric
 * below -- one rule, applied consistently, rather than five hand-tuned
 * copies. Returns null (no insight) when data is too sparse to
 * generalize from, per THRESHOLDS.MIN_PREVIOUS_FOR_TREND -- silence is
 * preferred over a misleading "+100%" from a 1-row swing.
 */
function buildTrendInsight(opts: {
  category: IntelligenceCategory
  metricLabel: string
  comparison: PeriodComparison
  ruleIdUp: RuleId
  ruleIdDown: RuleId
  actionHref?: string
  actionLabel?: string
}): DraftInsight | null {
  const { current, previous } = opts.comparison
  if (previous === null || previous < THRESHOLDS.MIN_PREVIOUS_FOR_TREND) return null

  const change = pct(previous, current)
  if (!Number.isFinite(change) || Math.abs(change) < THRESHOLDS.GROWTH_SWING_PCT) return null

  const rising = change > 0
  const dataSufficiency = previous >= THRESHOLDS.MIN_REAL_PROFILES_FOR_TREND ? 'sufficient' : 'limited'
  return {
    id: nextId('trend'),
    ruleId: rising ? opts.ruleIdUp : opts.ruleIdDown,
    category: opts.category,
    type: rising ? 'opportunity' : 'risk',
    priority: Math.abs(change) >= THRESHOLDS.GROWTH_SWING_PCT * 2 ? 'high' : 'medium',
    title: `${opts.metricLabel} ${rising ? 'up' : 'down'} ${Math.abs(Math.round(change))}% over the prior ${PERIOD} period`,
    summary: `${opts.metricLabel} went from ${previous} to ${current} compared with the preceding ${PERIOD} window.`,
    rationale: `${opts.metricLabel} for the current ${PERIOD} period (${current}) is compared against the equal-length preceding period (${previous}), both counted from confirmed Real Data only.`,
    evidence: [
      { label: `${opts.metricLabel} (current period)`, value: current },
      { label: `${opts.metricLabel} (prior period)`, value: previous },
      { label: 'Change', value: `${change > 0 ? '+' : ''}${Math.round(change)}%` },
    ],
    trigger: {
      metric: opts.metricLabel,
      operator: rising ? '>=' : '<=',
      observedValue: `${change > 0 ? '+' : ''}${Math.round(change)}%`,
      thresholdValue: `${THRESHOLDS.GROWTH_SWING_PCT}%`,
      comparisonValue: previous,
    },
    recommendation: rising
      ? `Confirm this growth is broad-based (not one merchant/channel) before reallocating budget toward it.`
      : `Investigate before concluding a structural decline -- check for a specific cause (a change, an outage, a seasonal pattern) in the affected period.`,
    confidence: previous >= THRESHOLDS.MIN_REAL_PROFILES_FOR_TREND ? 'medium' : 'low',
    dataSufficiency,
    scope: 'real-data',
    limitations: dataSufficiency !== 'sufficient' ? ['Insufficient prior-period sample for high statistical confidence.'] : [],
    generatedAt: new Date().toISOString(),
    actionHref: opts.actionHref,
    actionLabel: opts.actionLabel,
  }
}

function operationalBacklogInsight(opts: { ruleId: RuleId; label: string; count: number; actionHref: string; actionLabel: string; note?: string }): DraftInsight | null {
  if (opts.count < THRESHOLDS.OPERATIONAL_BACKLOG_WATCH_COUNT) return null
  const high = opts.count >= THRESHOLDS.OPERATIONAL_BACKLOG_HIGH_COUNT
  const threshold = high ? THRESHOLDS.OPERATIONAL_BACKLOG_HIGH_COUNT : THRESHOLDS.OPERATIONAL_BACKLOG_WATCH_COUNT
  return {
    id: nextId('ops'),
    ruleId: opts.ruleId,
    category: 'operations',
    type: high ? 'risk' : 'watch',
    priority: high ? 'high' : 'medium',
    title: `${opts.label} backlog: ${opts.count} item${opts.count === 1 ? '' : 's'}`,
    summary: `${opts.count} item${opts.count === 1 ? '' : 's'} currently sitting in the ${opts.label} operational queue.`,
    rationale: `${opts.label} is an all-system operational work queue (it intentionally includes test/QA records so staff can action every item, not just confirmed-real ones) -- its depth is a workload signal, not a business/customer metric.${opts.note ? ` ${opts.note}` : ''}`,
    evidence: [{ label: `${opts.label} queue depth`, value: opts.count }],
    trigger: {
      metric: `${opts.label} queue depth`,
      operator: '>=',
      observedValue: opts.count,
      thresholdValue: threshold,
    },
    recommendation: `Review and triage the ${opts.label} queue before it grows further.`,
    confidence: 'high',
    dataSufficiency: 'sufficient',
    scope: 'operational-all-system',
    limitations: ['Operational all-system scope: includes test/QA records; this is a workload count, not a confirmed-real business metric.'],
    generatedAt: new Date().toISOString(),
    actionHref: opts.actionHref,
    actionLabel: opts.actionLabel,
  }
}

// ============================================================
// Main entry point
// ============================================================

/**
 * Builds the full set of current Intelligence insights. Pure
 * read/aggregate -- every underlying query already exists in
 * analytics-service.ts/exceptions-service.ts; this function adds no
 * new table access of its own beyond the one Overview RPC call (for
 * the 5 already-established all-system operational fields) and
 * `listOperationalExceptions` (the canonical Exceptions queue).
 * Deterministic: given the same underlying data, always returns the
 * same insights in the same order.
 *
 * E1-F1 failure isolation: every one of the 10 input sources is
 * wrapped in `loadSource()` individually -- a rejection from any single
 * source can never reject this function as a whole (confirmed by this
 * phase's own adversarial test: previously, a single
 * getMarketplaceOverview() rejection rejected the entire result, which
 * -- because src/app/admin/page.tsx calls this function inside its own
 * unguarded Promise.all -- could take down the Admin Overview
 * homepage). A failed source is never silently substituted with a
 * zero/empty value and fed through its normal rules (that would turn
 * "unavailable" into "observed zero"); instead every `buildXInsights`
 * function below checks each of its own sources' `.ok` and skips
 * whatever specifically depends on a failed one, while a single
 * consolidated data-quality insight discloses which sources were
 * unavailable this cycle.
 */
export async function getIntelligenceInsights(admin: SupabaseClient): Promise<IntelligenceResult> {
  const generatedAt = new Date().toISOString()

  const [marketplace, supply, demand, transactions, trust, growth, behavior, support, overviewRpcOutcome, exceptions] = await Promise.all([
    loadSource(getMarketplaceOverview(admin, PERIOD)),
    loadSource(getSupplyAnalytics(admin, PERIOD)),
    loadSource(getDemandAnalytics(admin, PERIOD)),
    loadSource(getTransactionAnalytics(admin, PERIOD)),
    loadSource(getTrustAnalytics(admin, PERIOD)),
    loadSource(getGrowthAnalytics(admin, PERIOD)),
    loadSource(getBehaviorAnalytics(admin, PERIOD)),
    loadSource(getSupportAnalytics(admin, PERIOD)),
    loadSource((async () => {
      const { data, error } = await admin.rpc('get_admin_overview_stats')
      if (error) throw error
      return data as Record<string, number> | null
    })()),
    loadSource(listOperationalExceptions(admin)),
  ])

  const failedLabels = (
    [
      [marketplace, SOURCE_LABELS.marketplace],
      [supply, SOURCE_LABELS.supply],
      [demand, SOURCE_LABELS.demand],
      [transactions, SOURCE_LABELS.transactions],
      [trust, SOURCE_LABELS.trust],
      [growth, SOURCE_LABELS.growth],
      [behavior, SOURCE_LABELS.behavior],
      [support, SOURCE_LABELS.support],
      [overviewRpcOutcome, SOURCE_LABELS.overviewStats],
      [exceptions, SOURCE_LABELS.exceptions],
    ] as const
  )
    .filter(([outcome]) => !outcome.ok)
    .map(([, label]) => label)

  const insights: DraftInsight[] = []

  // ---- Degraded-source disclosure (first -- this takes precedence over any business insight) ----
  if (failedLabels.length > 0) insights.push(buildDegradedSourcesInsight(failedLabels))

  // ---- A. Data quality (these also often take precedence) ----
  insights.push(...buildDataQualityInsights({ marketplace, behavior }))

  // ---- B. Supply / demand ----
  insights.push(...buildSupplyDemandInsights({ marketplace, supply, demand }))

  // ---- C. Growth ----
  insights.push(...buildGrowthInsights(growth))

  // ---- D. Conversion ----
  const conversionInsight = buildConversionInsight(behavior)
  if (conversionInsight) insights.push(conversionInsight)

  // ---- E. Trust ----
  insights.push(...buildTrustInsights({ trust, transactions }))

  // ---- F. Operations (all-system) ----
  insights.push(...buildOperationsInsights({ support, overviewStats: overviewRpcOutcome, exceptions }))

  // E2: attach the honest, per-insight freshness disclosure before the
  // E1-F1 priority clamp -- order doesn't matter between the two (they
  // touch disjoint fields), but freshness first keeps every insight a
  // fully-typed IntelligenceInsight (not a DraftInsight) by the time the
  // clamp, sort, and summary logic below run.
  const freshInsights = insights.map(attachFreshness)

  // E1-F1: a thin-sample business insight cannot out-rank a
  // well-supported one merely by raw percentage magnitude -- applied
  // before sorting/summarizing so both reflect the clamped priority.
  const clampedInsights = freshInsights.map(clampBusinessPriority)

  // Stable, meaningful ordering: priority desc, then type (risk before
  // opportunity before watch before informational), then category name
  // -- never insertion order alone, so the page is deterministic
  // regardless of which Promise resolved first.
  const PRIORITY_RANK: Record<IntelligencePriority, number> = { high: 0, medium: 1, low: 2 }
  const TYPE_RANK: Record<IntelligenceInsightType, number> = { risk: 0, opportunity: 1, watch: 2, informational: 3 }
  clampedInsights.sort((a, b) => {
    if (PRIORITY_RANK[a.priority] !== PRIORITY_RANK[b.priority]) return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
    if (TYPE_RANK[a.type] !== TYPE_RANK[b.type]) return TYPE_RANK[a.type] - TYPE_RANK[b.type]
    return a.category.localeCompare(b.category)
  })

  const realDataInsights = clampedInsights.filter((i) => i.scope === 'real-data')
  const operationalInsights = clampedInsights.filter((i) => i.scope === 'operational-all-system')

  const summary: IntelligenceSummary = {
    totalInsights: clampedInsights.length,
    highPriority: clampedInsights.filter((i) => i.priority === 'high').length,
    opportunities: clampedInsights.filter((i) => i.type === 'opportunity').length,
    risksAndWatch: clampedInsights.filter((i) => i.type === 'risk' || i.type === 'watch').length,
    dataQualityLimitations: clampedInsights.filter((i) => i.dataSufficiency !== 'sufficient').length,
    realData: {
      highPriority: realDataInsights.filter((i) => i.priority === 'high').length,
      opportunities: realDataInsights.filter((i) => i.type === 'opportunity').length,
    },
    operational: {
      highPriority: operationalInsights.filter((i) => i.priority === 'high').length,
    },
  }

  // E2 source health: one row per input source, independent of whether
  // it produced an insight this cycle -- `usedBy` is static metadata
  // (SOURCE_USED_BY), never recomputed from the insight list, so a
  // degraded row is reported even on a cycle where none of its rules
  // happened to fire for an unrelated reason (e.g. floor not cleared).
  const outcomesBySource: Record<SourceKey, SourceOutcome<unknown>> = {
    marketplace, supply, demand, transactions, trust, growth, behavior, support,
    overviewStats: overviewRpcOutcome, exceptions,
  }
  const sourceHealth: IntelligenceSourceStatus[] = (Object.keys(SOURCE_LABELS) as SourceKey[]).map((key) => ({
    source: key,
    label: SOURCE_LABELS[key],
    status: outcomesBySource[key].ok ? 'available' : 'degraded',
    scope: SOURCE_SCOPE[key],
    usedBy: SOURCE_USED_BY[key],
  }))

  return { generatedAt, period: PERIOD, summary, insights: clampedInsights, sourceHealth }
}

// ============================================================
// Degraded-source disclosure
// ============================================================

/**
 * E1-F1: the single, consolidated finding emitted when one or more
 * input sources could not be read this cycle. Never includes a raw
 * exception message, stack trace, or table/column name -- only the
 * human-readable source label. `confidence: 'high'` here means "we are
 * confident these specific sources failed to return data", never
 * "we are confident about marketplace behavior" -- dataSufficiency is
 * always 'insufficient' for the same reason.
 */
function buildDegradedSourcesInsight(failedLabels: string[]): DraftInsight {
  const high = failedLabels.length >= THRESHOLDS.DEGRADED_SOURCES_HIGH_COUNT
  return {
    id: nextId('dq'),
    ruleId: RULE_IDS.DATA_PARTIAL_SOURCE_FAILURE,
    category: 'data-quality',
    type: 'informational',
    priority: high ? 'high' : 'medium',
    title: 'Intelligence inputs are partially unavailable',
    summary: `${failedLabels.length} of 10 analytics source(s) could not be read this cycle, so current recommendations may be incomplete.`,
    rationale: 'Deterministic, per-source failure isolation (E1-F1) -- a source that could not be read is excluded from every rule it feeds and is never treated as a genuine zero/no-activity observation. Successful sources below still contribute their own insights normally.',
    evidence: failedLabels.map((label) => ({ label: `${label} unavailable`, value: 'unavailable' })),
    trigger: {
      metric: 'Unavailable analytics sources',
      operator: '>=',
      observedValue: failedLabels.length,
      thresholdValue: THRESHOLDS.DEGRADED_SOURCES_HIGH_COUNT,
    },
    recommendation: 'Retry shortly; if this persists, check Admin service connectivity. Draw no business conclusion from the absence of these sources specifically.',
    confidence: 'high',
    dataSufficiency: 'insufficient',
    scope: 'real-data',
    limitations: ['Built from a reduced set of analytics sources this cycle -- see Source Health for which ones.'],
    generatedAt: new Date().toISOString(),
  }
}

// ============================================================
// A. Data quality
// ============================================================

function buildDataQualityInsights(ctx: {
  marketplace: SourceOutcome<Awaited<ReturnType<typeof getMarketplaceOverview>>>
  behavior: SourceOutcome<Awaited<ReturnType<typeof getBehaviorAnalytics>>>
}): DraftInsight[] {
  const out: DraftInsight[] = []
  const generatedAt = new Date().toISOString()

  if (ctx.marketplace.ok && ctx.marketplace.data && ctx.marketplace.data.totalUsers < THRESHOLDS.MIN_REAL_PROFILES_FOR_TREND) {
    const totalUsers = ctx.marketplace.data.totalUsers
    out.push({
      id: nextId('dq'),
      ruleId: RULE_IDS.DATA_INSUFFICIENT_REAL_PROFILES,
      category: 'data-quality',
      type: 'informational',
      priority: 'medium',
      title: 'Confirmed Real Data user base is still small',
      summary: `Only ${totalUsers} confirmed-real user profile(s) exist -- most percentage-based trend and growth comparisons below are not yet statistically meaningful.`,
      rationale: `data_classification = 'real' is positive-proof only (D3 policy) -- unresolved-legacy and unclassified accounts are correctly excluded, not guessed at, so this number is intentionally conservative rather than inflated.`,
      evidence: [{ label: 'Confirmed-real users', value: totalUsers }],
      trigger: {
        metric: 'Confirmed-real users',
        operator: '<',
        observedValue: totalUsers,
        thresholdValue: THRESHOLDS.MIN_REAL_PROFILES_FOR_TREND,
      },
      recommendation: 'Treat business insights below as directional until confirmed-real volume grows; prioritize resolving account provenance where legitimate.',
      confidence: 'high',
      dataSufficiency: 'insufficient',
      scope: 'real-data',
      limitations: ['Limited confirmed Real Data population for percentage-based comparisons.'],
      generatedAt,
    })
  }

  if (ctx.behavior.ok && ctx.behavior.data && !ctx.behavior.data.dataQuality.hasAnyEventData) {
    out.push({
      id: nextId('dq'),
      ruleId: RULE_IDS.DATA_NO_EVENT_DATA,
      category: 'data-quality',
      type: 'informational',
      priority: 'low',
      title: 'No first-party behavioral event data yet',
      summary: 'analytics_events has no rows yet in this environment -- Conversion insights cannot be produced.',
      rationale: 'D2 instrumentation has no historical backfill by design (src/lib/admin/analytics-service.ts) -- zero rows means tracking has not accumulated data yet, not that there is no activity.',
      evidence: [{ label: 'analytics_events rows observed', value: 0 }],
      trigger: { metric: 'analytics_events rows observed', operator: '==', observedValue: 0 },
      recommendation: 'No action needed -- this will resolve naturally as first-party event volume accumulates.',
      confidence: 'high',
      dataSufficiency: 'insufficient',
      scope: 'real-data',
      limitations: ['Incomplete telemetry: analytics_events has no historical backfill by design.'],
      generatedAt,
    })
  }

  out.push({
    id: nextId('dq'),
    ruleId: RULE_IDS.DATA_DISPUTES_UNVERIFIED,
    category: 'data-quality',
    type: 'informational',
    priority: 'low',
    title: 'Dispute counts may include unresolved QA/test activity',
    summary: 'No reliable relational test-exclusion path exists yet for disputes (a 2-hop relationship through booking/order/barter, each a different join target), so no Trust risk insight is generated from raw dispute counts in this phase.',
    rationale: 'Per D3 policy, an unverifiable population must never be presented as a confirmed Real Data risk signal -- disputesByStatus is reported elsewhere in Admin Analytics with this same honest caveat (mayIncludeTestData: true), never silently implied real-only.',
    evidence: [],
    trigger: { metric: 'Dispute test-exclusion reliability' },
    recommendation: 'Review the Disputes queue directly for current case detail; a dedicated relational fix would be required before this becomes a scored Trust insight.',
    confidence: 'high',
    dataSufficiency: 'insufficient',
    scope: 'real-data',
    limitations: ['No reliable relational test-exclusion path exists for disputes yet.'],
    generatedAt,
    actionHref: '/admin/disputes',
    actionLabel: 'Review disputes',
  })

  return out
}

// ============================================================
// B. Supply / demand
// ============================================================

function buildSupplyDemandInsights(ctx: {
  marketplace: SourceOutcome<Awaited<ReturnType<typeof getMarketplaceOverview>>>
  supply: SourceOutcome<Awaited<ReturnType<typeof getSupplyAnalytics>>>
  demand: SourceOutcome<Awaited<ReturnType<typeof getDemandAnalytics>>>
}): DraftInsight[] {
  const out: DraftInsight[] = []
  const generatedAt = new Date().toISOString()

  // This rule cross-references all three sources at once (real active
  // listings vs. demand vs. category mix) -- a partial read would
  // produce a misleading comparison, so it stays silent unless every
  // one of the three is available this cycle (E1-F1 failure isolation).
  if (!ctx.marketplace.ok || !ctx.marketplace.data || !ctx.supply.ok || !ctx.supply.data || !ctx.demand.ok || !ctx.demand.data) return out

  const realActiveListings = ctx.marketplace.data.realActiveListings

  if (realActiveListings < THRESHOLDS.MIN_REAL_LISTINGS_FOR_SUPPLY_SIGNAL) return out

  const lookingForTotal = ctx.demand.data.lookingFor.total
  if (lookingForTotal >= realActiveListings * THRESHOLDS.DEMAND_SUPPLY_RATIO_WATCH) {
    const dataSufficiency = realActiveListings >= THRESHOLDS.MIN_REAL_PROFILES_FOR_TREND ? 'sufficient' : 'limited'
    out.push({
      id: nextId('demand'),
      ruleId: RULE_IDS.DEMAND_SUPPLY_IMBALANCE,
      category: 'demand',
      type: 'opportunity',
      priority: 'medium',
      title: 'Looking For demand outpaces real active listing supply',
      summary: `${lookingForTotal} active Looking For request(s) against ${realActiveListings} confirmed-real active listing(s).`,
      rationale: 'Looking For requests represent explicit unmet demand (a renter/buyer could not find what they wanted in current supply); comparing their volume to real active listing supply is a direct, already-exposed signal, not an inference beyond what the analytics layer reports.',
      evidence: [
        { label: 'Looking For requests (non-test)', value: lookingForTotal },
        { label: 'Real active listings', value: realActiveListings },
      ],
      trigger: {
        metric: 'Looking For requests vs. real active listings',
        operator: '>=',
        observedValue: lookingForTotal,
        thresholdValue: realActiveListings * THRESHOLDS.DEMAND_SUPPLY_RATIO_WATCH,
        comparisonValue: realActiveListings,
      },
      recommendation: 'Consider merchant acquisition or listing incentives; review Looking For categories for specific gaps before committing budget.',
      confidence: realActiveListings >= THRESHOLDS.MIN_REAL_PROFILES_FOR_TREND ? 'medium' : 'low',
      dataSufficiency,
      scope: 'real-data',
      limitations: dataSufficiency !== 'sufficient' ? ['Limited confirmed Real Data sample for this comparison.'] : [],
      generatedAt,
      actionHref: '/admin/marketplace-requests',
      actionLabel: 'Review Looking For requests',
    })
  }

  const topCategory = ctx.supply.data.listingsByCategory[0]
  if (topCategory && topCategory.count / realActiveListings >= THRESHOLDS.CATEGORY_CONCENTRATION_SHARE) {
    const share = Math.round((topCategory.count / realActiveListings) * 100)
    out.push({
      id: nextId('supply'),
      ruleId: RULE_IDS.SUPPLY_CATEGORY_CONCENTRATION,
      category: 'supply',
      type: 'watch',
      priority: 'low',
      title: `Real active listing supply is concentrated in "${topCategory.label}"`,
      summary: `${share}% of confirmed-real active listings (${topCategory.count} of ${realActiveListings}) are in a single category.`,
      rationale: 'Category breakdown is taken directly from the already-reported real active listing set, grouped by its own category column -- no cross-table inference.',
      evidence: [
        { label: 'Top category', value: topCategory.label },
        { label: 'Listings in top category', value: topCategory.count },
        { label: 'Share of real active listings', value: `${share}%` },
      ],
      trigger: {
        metric: `${topCategory.label} share of real active listings`,
        operator: '>=',
        observedValue: `${share}%`,
        thresholdValue: `${Math.round(THRESHOLDS.CATEGORY_CONCENTRATION_SHARE * 100)}%`,
      },
      recommendation: 'Consider whether category diversification is a goal; this is descriptive, not a judgment that concentration is itself a problem.',
      confidence: 'medium',
      dataSufficiency: 'limited',
      scope: 'real-data',
      limitations: ['Limited confirmed Real Data sample for this comparison.'],
      generatedAt,
      actionHref: '/admin/listings',
      actionLabel: 'Review listings',
    })
  }

  return out
}

// ============================================================
// C. Growth
// ============================================================

function buildGrowthInsights(growth: SourceOutcome<Awaited<ReturnType<typeof getGrowthAnalytics>>>): DraftInsight[] {
  const out: DraftInsight[] = []
  if (!growth.ok || !growth.data) return out
  const g = growth.data
  const candidates: Array<{ metricLabel: string; comparison: PeriodComparison; ruleIdUp: RuleId; ruleIdDown: RuleId; actionHref?: string; actionLabel?: string }> = [
    { metricLabel: 'New users', comparison: g.newUsers, ruleIdUp: RULE_IDS.GROWTH_NEW_USERS_UP, ruleIdDown: RULE_IDS.GROWTH_NEW_USERS_DOWN, actionHref: '/admin/users', actionLabel: 'Review users' },
    { metricLabel: 'New merchants', comparison: g.newMerchants, ruleIdUp: RULE_IDS.GROWTH_NEW_MERCHANTS_UP, ruleIdDown: RULE_IDS.GROWTH_NEW_MERCHANTS_DOWN, actionHref: '/admin/merchants', actionLabel: 'Review merchants' },
    { metricLabel: 'New real listings', comparison: g.newRealListings, ruleIdUp: RULE_IDS.GROWTH_NEW_REAL_LISTINGS_UP, ruleIdDown: RULE_IDS.GROWTH_NEW_REAL_LISTINGS_DOWN, actionHref: '/admin/listings', actionLabel: 'Review listings' },
    { metricLabel: 'New bookings', comparison: g.newBookings, ruleIdUp: RULE_IDS.GROWTH_NEW_BOOKINGS_UP, ruleIdDown: RULE_IDS.GROWTH_NEW_BOOKINGS_DOWN, actionHref: '/admin/bookings', actionLabel: 'Review bookings' },
    { metricLabel: 'New orders', comparison: g.newOrders, ruleIdUp: RULE_IDS.GROWTH_NEW_ORDERS_UP, ruleIdDown: RULE_IDS.GROWTH_NEW_ORDERS_DOWN, actionHref: '/admin/orders', actionLabel: 'Review orders' },
  ]
  for (const c of candidates) {
    const insight = buildTrendInsight({ category: 'growth', metricLabel: c.metricLabel, comparison: c.comparison, ruleIdUp: c.ruleIdUp, ruleIdDown: c.ruleIdDown, actionHref: c.actionHref, actionLabel: c.actionLabel })
    if (insight) out.push(insight)
  }
  return out
}

// ============================================================
// D. Conversion
// ============================================================

/**
 * D3-F established (and this function's own independent trace of every
 * recordAnalyticsEvent() call site confirms) that EVERY funnel's
 * "started" event type -- signup_started, listing_creation_started,
 * rental_checkout_started, order_checkout_started, kyc_started -- has
 * no listing anchor and is therefore ALWAYS classified 'unknown', NEVER
 * 'real', under the current instrumentation. That makes
 * safeConversionRate(started=0, completed) permanently null for all
 * five funnels today -- not occasionally, always. Fabricating a
 * "conversion collapsed" insight from that would be exactly the
 * forbidden pattern (Section 8D); this function instead reports the
 * structural limitation honestly, once, as a single Conversion-category
 * data-sufficiency finding.
 */
function buildConversionInsight(behavior: SourceOutcome<Awaited<ReturnType<typeof getBehaviorAnalytics>>>): DraftInsight | null {
  if (!behavior.ok || !behavior.data) return null // source unavailable this cycle -- the degraded-source disclosure already covers this; no fabricated conversion insight is produced
  if (!behavior.data.dataQuality.hasAnyEventData) return null // the general "no event data yet" data-quality insight already covers this case

  const b = behavior.data
  const anyCompleted = b.listingCreationFunnel.completed > 0 || b.rentalFunnel.completed > 0 || b.orderFunnel.completed > 0

  return {
    id: nextId('conv'),
    ruleId: RULE_IDS.CONVERSION_NOT_COMPUTABLE,
    category: 'conversion',
    type: 'informational',
    priority: 'low',
    title: 'Funnel conversion rates cannot currently be computed from confirmed Real Data',
    summary: 'Every funnel\'s "started" event type lacks a listing anchor under the current instrumentation, so it is always classified \'unknown\', never \'real\' -- conversion rate is therefore null for every funnel today, not evidence of a conversion problem.',
    rationale: 'Confirmed from source: only listing-anchored events (listing_viewed with an entity, listing_published, booking_created, order_created) can ever receive a real/test classification; signup_started, listing_creation_started, rental_checkout_started, order_checkout_started, and kyc_started have no such anchor and default to \'unknown\' at the point of creation.',
    evidence: [
      { label: 'Real listings published', value: b.listingCreationFunnel.completed },
      { label: 'Real bookings created', value: b.rentalFunnel.completed },
      { label: 'Real orders created', value: b.orderFunnel.completed },
    ],
    trigger: { metric: 'Funnel "started" event real/test classification' },
    recommendation: anyCompleted
      ? 'Completion-side counts above are confirmed-real and usable on their own as activity volume; do not combine them with the unmeasurable "started" side into a rate.'
      : 'No confirmed-real completions yet either -- treat the whole Conversion category as insufficient data for now.',
    confidence: 'high',
    dataSufficiency: 'insufficient',
    scope: 'real-data',
    limitations: ['Structural telemetry gap: funnel "started" events lack a listing anchor and are always classified unknown under current instrumentation.'],
    generatedAt: new Date().toISOString(),
  }
}

// ============================================================
// E. Trust
// ============================================================

function buildTrustInsights(ctx: {
  trust: SourceOutcome<Awaited<ReturnType<typeof getTrustAnalytics>>>
  transactions: SourceOutcome<Awaited<ReturnType<typeof getTransactionAnalytics>>>
}): DraftInsight[] {
  const out: DraftInsight[] = []
  const generatedAt = new Date().toISOString()

  if (!ctx.trust.ok || !ctx.trust.data) return out
  const trust = ctx.trust.data

  const { restricted, suspended } = trust.accountRestrictions
  const restrictionTotal = restricted + suspended
  if (restrictionTotal >= THRESHOLDS.RESTRICTION_WATCH_COUNT) {
    const dataSufficiency = restrictionTotal >= THRESHOLDS.RESTRICTION_WATCH_COUNT * 2 ? 'sufficient' : 'limited'
    out.push({
      id: nextId('trust'),
      ruleId: RULE_IDS.TRUST_ACCOUNT_RESTRICTIONS,
      category: 'trust',
      type: 'watch',
      priority: restrictionTotal >= THRESHOLDS.RESTRICTION_WATCH_COUNT * 3 ? 'high' : 'medium',
      title: 'Confirmed-real accounts are currently restricted or suspended',
      summary: `${restrictionTotal} confirmed-real account(s) are restricted (${restricted}) or suspended (${suspended}).`,
      rationale: 'account_status counts here are filtered to data_classification = \'real\' only (D3-F) -- this reflects genuine account actions, not QA/test accounts.',
      evidence: [
        { label: 'Restricted (real)', value: restricted },
        { label: 'Suspended (real)', value: suspended },
      ],
      trigger: {
        metric: 'Restricted + suspended confirmed-real accounts',
        operator: '>=',
        observedValue: restrictionTotal,
        thresholdValue: THRESHOLDS.RESTRICTION_WATCH_COUNT,
      },
      recommendation: 'Review recent account actions for a common cause (fraud pattern, policy change, false-positive rule) before assuming each is isolated.',
      confidence: 'medium',
      dataSufficiency,
      scope: 'real-data',
      limitations: dataSufficiency === 'limited' ? ['Small confirmed-real cohort; pattern may not generalize.'] : [],
      generatedAt,
      actionHref: '/admin/users',
      actionLabel: 'Review users',
    })
  }

  const kycTotal = trust.kycByStatus.reduce((s, r) => s + r.count, 0)
  if (kycTotal >= THRESHOLDS.MIN_REAL_KYC_ROWS_FOR_INFO) {
    const approved = trust.kycByStatus.find((r) => r.label === 'approved')?.count ?? 0
    const approvedShare = Math.round((approved / kycTotal) * 100)
    const dataSufficiency = kycTotal >= THRESHOLDS.MIN_REAL_PROFILES_FOR_TREND ? 'sufficient' : 'limited'
    out.push({
      id: nextId('trust'),
      ruleId: RULE_IDS.TRUST_KYC_STATUS_MIX,
      category: 'trust',
      type: 'informational',
      priority: 'low',
      title: 'Confirmed-real KYC status mix',
      summary: `${approvedShare}% of confirmed-real users with a recorded KYC status (${kycTotal} total) are approved.`,
      rationale: 'kyc_status breakdown here is filtered to data_classification = \'real\' only (D3-F) -- distinct from the all-system KYC review queue reported under Operations below.',
      evidence: trust.kycByStatus.map((r) => ({ label: r.label, value: r.count })),
      trigger: {
        metric: 'Confirmed-real users with recorded KYC status',
        operator: '>=',
        observedValue: kycTotal,
        thresholdValue: THRESHOLDS.MIN_REAL_KYC_ROWS_FOR_INFO,
      },
      recommendation: 'No action implied -- informational baseline for tracking KYC approval mix as real volume grows.',
      confidence: kycTotal >= THRESHOLDS.MIN_REAL_PROFILES_FOR_TREND ? 'medium' : 'low',
      dataSufficiency,
      scope: 'real-data',
      limitations: dataSufficiency === 'limited' ? ['Small confirmed-real KYC sample.'] : [],
      generatedAt,
    })
  }

  if (!ctx.transactions.ok || !ctx.transactions.data) return out
  const transactions = ctx.transactions.data

  const realTransactions = transactions.bookings.total + transactions.orders.total
  if (realTransactions >= THRESHOLDS.MIN_REAL_TRANSACTIONS_FOR_REVIEW_RATIO) {
    const reviewsPerTransaction = trust.publishedReviews / realTransactions
    if (reviewsPerTransaction < 0.1) {
      out.push({
        id: nextId('trust'),
        ruleId: RULE_IDS.TRUST_REVIEWS_SPARSE,
        category: 'trust',
        type: 'watch',
        priority: 'low',
        title: 'Published reviews are sparse relative to completed transactions',
        summary: `${trust.publishedReviews} published review(s) against ${realTransactions} real booking(s)/order(s) this period.`,
        rationale: 'Both figures are already-reported, independently real-filtered counts (published reviews: is_test=false; bookings/orders: relationally excluded from test listings) -- this is a direct ratio of two existing metrics, not a new data source.',
        evidence: [
          { label: 'Published reviews', value: trust.publishedReviews },
          { label: 'Real bookings + orders', value: realTransactions },
        ],
        trigger: {
          metric: 'Published reviews per real transaction',
          operator: '<',
          observedValue: Math.round(reviewsPerTransaction * 100) / 100,
          thresholdValue: 0.1,
        },
        recommendation: 'Consider a post-transaction review prompt if review collection is a priority; this is descriptive, not proof of a quality problem.',
        confidence: 'low',
        dataSufficiency: 'limited',
        scope: 'real-data',
        limitations: ['Low-confidence ratio from a small/mixed-granularity sample.'],
        generatedAt,
        actionHref: '/admin/reviews',
        actionLabel: 'Review moderation',
      })
    }
  }

  return out
}

// ============================================================
// F. Operations (all-system)
// ============================================================

function buildOperationsInsights(ctx: {
  support: SourceOutcome<Awaited<ReturnType<typeof getSupportAnalytics>>>
  overviewStats: SourceOutcome<Record<string, number> | null>
  exceptions: SourceOutcome<Awaited<ReturnType<typeof listOperationalExceptions>>>
}): DraftInsight[] {
  const out: DraftInsight[] = []

  if (ctx.support.ok && ctx.support.data) {
    const openSupportCases = ctx.support.data.byStatus.filter((r) => r.label !== 'resolved' && r.label !== 'closed').reduce((s, r) => s + r.count, 0)
    const supportInsight = operationalBacklogInsight({
      ruleId: RULE_IDS.OPERATIONS_SUPPORT_BACKLOG,
      label: 'Support',
      count: openSupportCases,
      actionHref: '/admin/support',
      actionLabel: 'Review support queue',
      note: 'Counted as every case not yet resolved/closed in the current period.',
    })
    if (supportInsight) out.push(supportInsight)
  }

  if (ctx.overviewStats.ok && ctx.overviewStats.data) {
    const fields: Array<{ key: string; label: string; ruleId: RuleId; actionHref: string; actionLabel: string }> = [
      { key: 'pending_kyc_reviews', label: 'KYC review', ruleId: RULE_IDS.OPERATIONS_KYC_REVIEW_BACKLOG, actionHref: '/admin/verifications', actionLabel: 'Review KYC queue' },
      { key: 'pending_ownership_reviews', label: 'Ownership verification', ruleId: RULE_IDS.OPERATIONS_OWNERSHIP_REVIEW_BACKLOG, actionHref: '/admin/listings', actionLabel: 'Review ownership queue' },
      { key: 'pending_listing_moderation', label: 'Listing moderation', ruleId: RULE_IDS.OPERATIONS_LISTING_MODERATION_BACKLOG, actionHref: '/admin/listings', actionLabel: 'Review moderation queue' },
      { key: 'failed_financial_workflows', label: 'Failed financial workflow', ruleId: RULE_IDS.OPERATIONS_FAILED_FINANCIAL_WORKFLOW_BACKLOG, actionHref: '/admin/financial-operations', actionLabel: 'Review financial operations' },
      { key: 'retryable_email_failures', label: 'Retryable email failure', ruleId: RULE_IDS.OPERATIONS_EMAIL_FAILURE_BACKLOG, actionHref: '/admin/email-deliveries', actionLabel: 'Review email deliveries' },
    ]
    for (const f of fields) {
      const count = ctx.overviewStats.data[f.key]
      if (typeof count !== 'number') continue
      const insight = operationalBacklogInsight({ ruleId: f.ruleId, label: f.label, count, actionHref: f.actionHref, actionLabel: f.actionLabel })
      if (insight) out.push(insight)
    }
  }

  if (ctx.exceptions.ok && ctx.exceptions.data) {
    const unresolvedExceptions = ctx.exceptions.data.filter((e) => !e.resolved)
    const highSeverityExceptions = unresolvedExceptions.filter((e) => e.severity === 'high').length
    const exceptionsInsight = operationalBacklogInsight({
      ruleId: RULE_IDS.OPERATIONS_EXCEPTIONS_BACKLOG,
      label: 'Exceptions',
      count: unresolvedExceptions.length,
      actionHref: '/admin/exceptions',
      actionLabel: 'Review exceptions',
      note: highSeverityExceptions > 0 ? `${highSeverityExceptions} marked high severity.` : undefined,
    })
    if (exceptionsInsight) out.push(exceptionsInsight)
  }

  return out
}
