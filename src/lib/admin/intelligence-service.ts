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

export interface IntelligenceInsight {
  id: string
  category: IntelligenceCategory
  type: IntelligenceInsightType
  priority: IntelligencePriority
  title: string
  summary: string
  /** What was compared/observed and why it matters -- never a bare "AI detected a risk" style claim. */
  rationale: string
  evidence: IntelligenceEvidence[]
  /** Advisory text only. Never describes or implies an automated action -- see this module's own header comment. */
  recommendation: string
  confidence: IntelligenceConfidence
  dataSufficiency: IntelligenceDataSufficiency
  scope: IntelligenceScope
  generatedAt: string
  /** Plain navigation to an existing Admin page -- never an action/mutation endpoint. */
  actionHref?: string
  actionLabel?: string
}

export interface IntelligenceSummary {
  totalInsights: number
  highPriority: number
  opportunities: number
  risksAndWatch: number
  dataQualityLimitations: number
}

export interface IntelligenceResult {
  generatedAt: string
  period: '30d'
  summary: IntelligenceSummary
  insights: IntelligenceInsight[]
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
} as const

const PERIOD = '30d' as const

// ============================================================
// Small helpers
// ============================================================

let insightCounter = 0
function nextId(prefix: string): string {
  insightCounter += 1
  return `${prefix}-${insightCounter}`
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
  actionHref?: string
  actionLabel?: string
}): IntelligenceInsight | null {
  const { current, previous } = opts.comparison
  if (previous === null || previous < THRESHOLDS.MIN_PREVIOUS_FOR_TREND) return null

  const change = pct(previous, current)
  if (!Number.isFinite(change) || Math.abs(change) < THRESHOLDS.GROWTH_SWING_PCT) return null

  const rising = change > 0
  return {
    id: nextId('trend'),
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
    recommendation: rising
      ? `Confirm this growth is broad-based (not one merchant/channel) before reallocating budget toward it.`
      : `Investigate before concluding a structural decline -- check for a specific cause (a change, an outage, a seasonal pattern) in the affected period.`,
    confidence: previous >= THRESHOLDS.MIN_REAL_PROFILES_FOR_TREND ? 'medium' : 'low',
    dataSufficiency: previous >= THRESHOLDS.MIN_REAL_PROFILES_FOR_TREND ? 'sufficient' : 'limited',
    scope: 'real-data',
    generatedAt: new Date().toISOString(),
    actionHref: opts.actionHref,
    actionLabel: opts.actionLabel,
  }
}

function operationalBacklogInsight(opts: { label: string; count: number; actionHref: string; actionLabel: string; note?: string }): IntelligenceInsight | null {
  if (opts.count < THRESHOLDS.OPERATIONAL_BACKLOG_WATCH_COUNT) return null
  const high = opts.count >= THRESHOLDS.OPERATIONAL_BACKLOG_HIGH_COUNT
  return {
    id: nextId('ops'),
    category: 'operations',
    type: high ? 'risk' : 'watch',
    priority: high ? 'high' : 'medium',
    title: `${opts.label} backlog: ${opts.count} item${opts.count === 1 ? '' : 's'}`,
    summary: `${opts.count} item${opts.count === 1 ? '' : 's'} currently sitting in the ${opts.label} operational queue.`,
    rationale: `${opts.label} is an all-system operational work queue (it intentionally includes test/QA records so staff can action every item, not just confirmed-real ones) -- its depth is a workload signal, not a business/customer metric.${opts.note ? ` ${opts.note}` : ''}`,
    evidence: [{ label: `${opts.label} queue depth`, value: opts.count }],
    recommendation: `Review and triage the ${opts.label} queue before it grows further.`,
    confidence: 'high',
    dataSufficiency: 'sufficient',
    scope: 'operational-all-system',
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
 */
export async function getIntelligenceInsights(admin: SupabaseClient): Promise<IntelligenceResult> {
  const generatedAt = new Date().toISOString()

  const [marketplace, supply, demand, transactions, trust, growth, behavior, support, overviewRpc, exceptions] = await Promise.all([
    getMarketplaceOverview(admin, PERIOD),
    getSupplyAnalytics(admin, PERIOD),
    getDemandAnalytics(admin, PERIOD),
    getTransactionAnalytics(admin, PERIOD),
    getTrustAnalytics(admin, PERIOD),
    getGrowthAnalytics(admin, PERIOD),
    getBehaviorAnalytics(admin, PERIOD),
    getSupportAnalytics(admin, PERIOD),
    admin.rpc('get_admin_overview_stats'),
    listOperationalExceptions(admin).catch(() => []),
  ])

  const insights: IntelligenceInsight[] = []

  // ---- A. Data quality (evaluated first -- these often take precedence) ----
  insights.push(...buildDataQualityInsights({ marketplace, behavior }))

  // ---- B. Supply / demand ----
  const supplyDemand = buildSupplyDemandInsights({ marketplace, supply, demand })
  insights.push(...supplyDemand)

  // ---- C. Growth ----
  insights.push(...buildGrowthInsights(growth))

  // ---- D. Conversion ----
  const conversionInsight = buildConversionInsight(behavior)
  if (conversionInsight) insights.push(conversionInsight)

  // ---- E. Trust ----
  insights.push(...buildTrustInsights({ trust, transactions }))

  // ---- F. Operations (all-system) ----
  insights.push(...buildOperationsInsights({ support, overviewStats: (overviewRpc.data ?? null) as Record<string, number> | null, exceptions }))

  // Stable, meaningful ordering: priority desc, then type (risk before
  // opportunity before watch before informational), then category name
  // -- never insertion order alone, so the page is deterministic
  // regardless of which Promise resolved first.
  const PRIORITY_RANK: Record<IntelligencePriority, number> = { high: 0, medium: 1, low: 2 }
  const TYPE_RANK: Record<IntelligenceInsightType, number> = { risk: 0, opportunity: 1, watch: 2, informational: 3 }
  insights.sort((a, b) => {
    if (PRIORITY_RANK[a.priority] !== PRIORITY_RANK[b.priority]) return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
    if (TYPE_RANK[a.type] !== TYPE_RANK[b.type]) return TYPE_RANK[a.type] - TYPE_RANK[b.type]
    return a.category.localeCompare(b.category)
  })

  const summary: IntelligenceSummary = {
    totalInsights: insights.length,
    highPriority: insights.filter((i) => i.priority === 'high').length,
    opportunities: insights.filter((i) => i.type === 'opportunity').length,
    risksAndWatch: insights.filter((i) => i.type === 'risk' || i.type === 'watch').length,
    dataQualityLimitations: insights.filter((i) => i.dataSufficiency !== 'sufficient').length,
  }

  return { generatedAt, period: PERIOD, summary, insights }
}

// ============================================================
// A. Data quality
// ============================================================

function buildDataQualityInsights(ctx: {
  marketplace: Awaited<ReturnType<typeof getMarketplaceOverview>>
  behavior: Awaited<ReturnType<typeof getBehaviorAnalytics>>
}): IntelligenceInsight[] {
  const out: IntelligenceInsight[] = []
  const generatedAt = new Date().toISOString()

  if (ctx.marketplace.totalUsers < THRESHOLDS.MIN_REAL_PROFILES_FOR_TREND) {
    out.push({
      id: nextId('dq'),
      category: 'data-quality',
      type: 'informational',
      priority: 'medium',
      title: 'Confirmed Real Data user base is still small',
      summary: `Only ${ctx.marketplace.totalUsers} confirmed-real user profile(s) exist -- most percentage-based trend and growth comparisons below are not yet statistically meaningful.`,
      rationale: `data_classification = 'real' is positive-proof only (D3 policy) -- unresolved-legacy and unclassified accounts are correctly excluded, not guessed at, so this number is intentionally conservative rather than inflated.`,
      evidence: [{ label: 'Confirmed-real users', value: ctx.marketplace.totalUsers }],
      recommendation: 'Treat business insights below as directional until confirmed-real volume grows; prioritize resolving account provenance where legitimate.',
      confidence: 'high',
      dataSufficiency: 'insufficient',
      scope: 'real-data',
      generatedAt,
    })
  }

  if (!ctx.behavior.dataQuality.hasAnyEventData) {
    out.push({
      id: nextId('dq'),
      category: 'data-quality',
      type: 'informational',
      priority: 'low',
      title: 'No first-party behavioral event data yet',
      summary: 'analytics_events has no rows yet in this environment -- Conversion insights cannot be produced.',
      rationale: 'D2 instrumentation has no historical backfill by design (src/lib/admin/analytics-service.ts) -- zero rows means tracking has not accumulated data yet, not that there is no activity.',
      evidence: [{ label: 'analytics_events rows observed', value: 0 }],
      recommendation: 'No action needed -- this will resolve naturally as first-party event volume accumulates.',
      confidence: 'high',
      dataSufficiency: 'insufficient',
      scope: 'real-data',
      generatedAt,
    })
  }

  out.push({
    id: nextId('dq'),
    category: 'data-quality',
    type: 'informational',
    priority: 'low',
    title: 'Dispute counts may include unresolved QA/test activity',
    summary: 'No reliable relational test-exclusion path exists yet for disputes (a 2-hop relationship through booking/order/barter, each a different join target), so no Trust risk insight is generated from raw dispute counts in this phase.',
    rationale: 'Per D3 policy, an unverifiable population must never be presented as a confirmed Real Data risk signal -- disputesByStatus is reported elsewhere in Admin Analytics with this same honest caveat (mayIncludeTestData: true), never silently implied real-only.',
    evidence: [],
    recommendation: 'Review the Disputes queue directly for current case detail; a dedicated relational fix would be required before this becomes a scored Trust insight.',
    confidence: 'high',
    dataSufficiency: 'insufficient',
    scope: 'real-data',
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
  marketplace: Awaited<ReturnType<typeof getMarketplaceOverview>>
  supply: Awaited<ReturnType<typeof getSupplyAnalytics>>
  demand: Awaited<ReturnType<typeof getDemandAnalytics>>
}): IntelligenceInsight[] {
  const out: IntelligenceInsight[] = []
  const generatedAt = new Date().toISOString()
  const realActiveListings = ctx.marketplace.realActiveListings

  if (realActiveListings < THRESHOLDS.MIN_REAL_LISTINGS_FOR_SUPPLY_SIGNAL) return out

  const lookingForTotal = ctx.demand.lookingFor.total
  if (lookingForTotal >= realActiveListings * THRESHOLDS.DEMAND_SUPPLY_RATIO_WATCH) {
    out.push({
      id: nextId('demand'),
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
      recommendation: 'Consider merchant acquisition or listing incentives; review Looking For categories for specific gaps before committing budget.',
      confidence: realActiveListings >= THRESHOLDS.MIN_REAL_PROFILES_FOR_TREND ? 'medium' : 'low',
      dataSufficiency: realActiveListings >= THRESHOLDS.MIN_REAL_PROFILES_FOR_TREND ? 'sufficient' : 'limited',
      scope: 'real-data',
      generatedAt,
      actionHref: '/admin/marketplace-requests',
      actionLabel: 'Review Looking For requests',
    })
  }

  const topCategory = ctx.supply.listingsByCategory[0]
  if (topCategory && topCategory.count / realActiveListings >= THRESHOLDS.CATEGORY_CONCENTRATION_SHARE) {
    const share = Math.round((topCategory.count / realActiveListings) * 100)
    out.push({
      id: nextId('supply'),
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
      recommendation: 'Consider whether category diversification is a goal; this is descriptive, not a judgment that concentration is itself a problem.',
      confidence: 'medium',
      dataSufficiency: 'limited',
      scope: 'real-data',
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

function buildGrowthInsights(growth: Awaited<ReturnType<typeof getGrowthAnalytics>>): IntelligenceInsight[] {
  const out: IntelligenceInsight[] = []
  const candidates: Array<{ metricLabel: string; comparison: PeriodComparison; actionHref?: string; actionLabel?: string }> = [
    { metricLabel: 'New users', comparison: growth.newUsers, actionHref: '/admin/users', actionLabel: 'Review users' },
    { metricLabel: 'New merchants', comparison: growth.newMerchants, actionHref: '/admin/merchants', actionLabel: 'Review merchants' },
    { metricLabel: 'New real listings', comparison: growth.newRealListings, actionHref: '/admin/listings', actionLabel: 'Review listings' },
    { metricLabel: 'New bookings', comparison: growth.newBookings, actionHref: '/admin/bookings', actionLabel: 'Review bookings' },
    { metricLabel: 'New orders', comparison: growth.newOrders, actionHref: '/admin/orders', actionLabel: 'Review orders' },
  ]
  for (const c of candidates) {
    const insight = buildTrendInsight({ category: 'growth', metricLabel: c.metricLabel, comparison: c.comparison, actionHref: c.actionHref, actionLabel: c.actionLabel })
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
function buildConversionInsight(behavior: Awaited<ReturnType<typeof getBehaviorAnalytics>>): IntelligenceInsight | null {
  if (!behavior.dataQuality.hasAnyEventData) return null // the general "no event data yet" data-quality insight already covers this case

  const anyCompleted = behavior.listingCreationFunnel.completed > 0 || behavior.rentalFunnel.completed > 0 || behavior.orderFunnel.completed > 0

  return {
    id: nextId('conv'),
    category: 'conversion',
    type: 'informational',
    priority: 'low',
    title: 'Funnel conversion rates cannot currently be computed from confirmed Real Data',
    summary: 'Every funnel\'s "started" event type lacks a listing anchor under the current instrumentation, so it is always classified \'unknown\', never \'real\' -- conversion rate is therefore null for every funnel today, not evidence of a conversion problem.',
    rationale: 'Confirmed from source: only listing-anchored events (listing_viewed with an entity, listing_published, booking_created, order_created) can ever receive a real/test classification; signup_started, listing_creation_started, rental_checkout_started, order_checkout_started, and kyc_started have no such anchor and default to \'unknown\' at the point of creation.',
    evidence: [
      { label: 'Real listings published', value: behavior.listingCreationFunnel.completed },
      { label: 'Real bookings created', value: behavior.rentalFunnel.completed },
      { label: 'Real orders created', value: behavior.orderFunnel.completed },
    ],
    recommendation: anyCompleted
      ? 'Completion-side counts above are confirmed-real and usable on their own as activity volume; do not combine them with the unmeasurable "started" side into a rate.'
      : 'No confirmed-real completions yet either -- treat the whole Conversion category as insufficient data for now.',
    confidence: 'high',
    dataSufficiency: 'insufficient',
    scope: 'real-data',
    generatedAt: new Date().toISOString(),
  }
}

// ============================================================
// E. Trust
// ============================================================

function buildTrustInsights(ctx: {
  trust: Awaited<ReturnType<typeof getTrustAnalytics>>
  transactions: Awaited<ReturnType<typeof getTransactionAnalytics>>
}): IntelligenceInsight[] {
  const out: IntelligenceInsight[] = []
  const generatedAt = new Date().toISOString()

  const { restricted, suspended } = ctx.trust.accountRestrictions
  const restrictionTotal = restricted + suspended
  if (restrictionTotal >= THRESHOLDS.RESTRICTION_WATCH_COUNT) {
    out.push({
      id: nextId('trust'),
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
      recommendation: 'Review recent account actions for a common cause (fraud pattern, policy change, false-positive rule) before assuming each is isolated.',
      confidence: 'medium',
      dataSufficiency: restrictionTotal >= THRESHOLDS.RESTRICTION_WATCH_COUNT * 2 ? 'sufficient' : 'limited',
      scope: 'real-data',
      generatedAt,
      actionHref: '/admin/users',
      actionLabel: 'Review users',
    })
  }

  const kycTotal = ctx.trust.kycByStatus.reduce((s, r) => s + r.count, 0)
  if (kycTotal >= THRESHOLDS.MIN_REAL_KYC_ROWS_FOR_INFO) {
    const approved = ctx.trust.kycByStatus.find((r) => r.label === 'approved')?.count ?? 0
    const approvedShare = Math.round((approved / kycTotal) * 100)
    out.push({
      id: nextId('trust'),
      category: 'trust',
      type: 'informational',
      priority: 'low',
      title: 'Confirmed-real KYC status mix',
      summary: `${approvedShare}% of confirmed-real users with a recorded KYC status (${kycTotal} total) are approved.`,
      rationale: 'kyc_status breakdown here is filtered to data_classification = \'real\' only (D3-F) -- distinct from the all-system KYC review queue reported under Operations below.',
      evidence: ctx.trust.kycByStatus.map((r) => ({ label: r.label, value: r.count })),
      recommendation: 'No action implied -- informational baseline for tracking KYC approval mix as real volume grows.',
      confidence: kycTotal >= THRESHOLDS.MIN_REAL_PROFILES_FOR_TREND ? 'medium' : 'low',
      dataSufficiency: kycTotal >= THRESHOLDS.MIN_REAL_PROFILES_FOR_TREND ? 'sufficient' : 'limited',
      scope: 'real-data',
      generatedAt,
    })
  }

  const realTransactions = ctx.transactions.bookings.total + ctx.transactions.orders.total
  if (realTransactions >= THRESHOLDS.MIN_REAL_TRANSACTIONS_FOR_REVIEW_RATIO) {
    const reviewsPerTransaction = ctx.trust.publishedReviews / realTransactions
    if (reviewsPerTransaction < 0.1) {
      out.push({
        id: nextId('trust'),
        category: 'trust',
        type: 'watch',
        priority: 'low',
        title: 'Published reviews are sparse relative to completed transactions',
        summary: `${ctx.trust.publishedReviews} published review(s) against ${realTransactions} real booking(s)/order(s) this period.`,
        rationale: 'Both figures are already-reported, independently real-filtered counts (published reviews: is_test=false; bookings/orders: relationally excluded from test listings) -- this is a direct ratio of two existing metrics, not a new data source.',
        evidence: [
          { label: 'Published reviews', value: ctx.trust.publishedReviews },
          { label: 'Real bookings + orders', value: realTransactions },
        ],
        recommendation: 'Consider a post-transaction review prompt if review collection is a priority; this is descriptive, not proof of a quality problem.',
        confidence: 'low',
        dataSufficiency: 'limited',
        scope: 'real-data',
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
  support: Awaited<ReturnType<typeof getSupportAnalytics>>
  overviewStats: Record<string, number> | null
  exceptions: Awaited<ReturnType<typeof listOperationalExceptions>>
}): IntelligenceInsight[] {
  const out: IntelligenceInsight[] = []

  const openSupportCases = ctx.support.byStatus.filter((r) => r.label !== 'resolved' && r.label !== 'closed').reduce((s, r) => s + r.count, 0)
  const supportInsight = operationalBacklogInsight({
    label: 'Support',
    count: openSupportCases,
    actionHref: '/admin/support',
    actionLabel: 'Review support queue',
    note: 'Counted as every case not yet resolved/closed in the current period.',
  })
  if (supportInsight) out.push(supportInsight)

  if (ctx.overviewStats) {
    const fields: Array<{ key: string; label: string; actionHref: string; actionLabel: string }> = [
      { key: 'pending_kyc_reviews', label: 'KYC review', actionHref: '/admin/verifications', actionLabel: 'Review KYC queue' },
      { key: 'pending_ownership_reviews', label: 'Ownership verification', actionHref: '/admin/listings', actionLabel: 'Review ownership queue' },
      { key: 'pending_listing_moderation', label: 'Listing moderation', actionHref: '/admin/listings', actionLabel: 'Review moderation queue' },
      { key: 'failed_financial_workflows', label: 'Failed financial workflow', actionHref: '/admin/financial-operations', actionLabel: 'Review financial operations' },
      { key: 'retryable_email_failures', label: 'Retryable email failure', actionHref: '/admin/email-deliveries', actionLabel: 'Review email deliveries' },
    ]
    for (const f of fields) {
      const count = ctx.overviewStats[f.key]
      if (typeof count !== 'number') continue
      const insight = operationalBacklogInsight({ label: f.label, count, actionHref: f.actionHref, actionLabel: f.actionLabel })
      if (insight) out.push(insight)
    }
  }

  const unresolvedExceptions = ctx.exceptions.filter((e) => !e.resolved)
  const highSeverityExceptions = unresolvedExceptions.filter((e) => e.severity === 'high').length
  const exceptionsInsight = operationalBacklogInsight({
    label: 'Exceptions',
    count: unresolvedExceptions.length,
    actionHref: '/admin/exceptions',
    actionLabel: 'Review exceptions',
    note: highSeverityExceptions > 0 ? `${highSeverityExceptions} marked high severity.` : undefined,
  })
  if (exceptionsInsight) out.push(exceptionsInsight)

  return out
}
