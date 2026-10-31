import { describe, it, expect, vi, beforeEach } from 'vitest'
import type {
  MarketplaceOverview, SupplyAnalytics, DemandAnalytics, TransactionAnalytics, TrustAnalytics,
  GrowthAnalytics, BehaviorAnalytics, SupportAnalytics, StatusBreakdown, PeriodComparison,
} from '../analytics-service'

const getMarketplaceOverview = vi.fn()
const getSupplyAnalytics = vi.fn()
const getDemandAnalytics = vi.fn()
const getTransactionAnalytics = vi.fn()
const getTrustAnalytics = vi.fn()
const getGrowthAnalytics = vi.fn()
const getBehaviorAnalytics = vi.fn()
const getSupportAnalytics = vi.fn()

vi.mock('@/lib/admin/analytics-service', () => ({
  getMarketplaceOverview: (...a: unknown[]) => getMarketplaceOverview(...a),
  getSupplyAnalytics: (...a: unknown[]) => getSupplyAnalytics(...a),
  getDemandAnalytics: (...a: unknown[]) => getDemandAnalytics(...a),
  getTransactionAnalytics: (...a: unknown[]) => getTransactionAnalytics(...a),
  getTrustAnalytics: (...a: unknown[]) => getTrustAnalytics(...a),
  getGrowthAnalytics: (...a: unknown[]) => getGrowthAnalytics(...a),
  getBehaviorAnalytics: (...a: unknown[]) => getBehaviorAnalytics(...a),
  getSupportAnalytics: (...a: unknown[]) => getSupportAnalytics(...a),
}))

const listOperationalExceptions = vi.fn()
vi.mock('@/lib/admin/exceptions-service', () => ({
  listOperationalExceptions: (...a: unknown[]) => listOperationalExceptions(...a),
}))

const { getIntelligenceInsights, RULE_IDS, RULE_REGISTRY, THRESHOLDS, FINGERPRINT_VERSION } = await import('../intelligence-service')
const THRESHOLDS_KEYS = Object.keys(THRESHOLDS)

// ---- Baseline zero/sparse-data fixtures -- the "nothing confirmed-real yet" state ----
const ZERO_COMPARISON: PeriodComparison = { current: 0, previous: null }

const ZERO_MARKETPLACE: MarketplaceOverview = {
  totalUsers: 0, nonErasedUsers: 0, merchantUsers: 0, renterUsers: 0,
  realActiveListings: 0, realActiveMerchants: 0,
  newUsers: ZERO_COMPARISON, newRealListings: ZERO_COMPARISON,
}
const ZERO_SUPPLY: SupplyAnalytics = {
  activeListings: 0, activeMerchants: 0, listingsByCategory: [], listingsByProvince: [],
  listingCreationTrend: [], dataQuality: { missingProvince: 0, missingCity: 0, missingCollectionArea: 0, insufficientMedia: 0, ownershipVerifiedCount: 0, ownershipNotVerifiedCount: 0 },
}
const ZERO_DEMAND: DemandAnalytics = { searchDemand: { windowDays: 30, trends: [], hasSufficientData: false }, lookingFor: { byCategory: [], byStatus: [], total: 0 } }
const ZERO_STATUS_BREAKDOWN: StatusBreakdown = { domain: '', total: 0, byStatus: [], mayIncludeTestData: false }
const ZERO_TRANSACTIONS: TransactionAnalytics = {
  bookings: { ...ZERO_STATUS_BREAKDOWN, domain: 'Rental bookings' },
  orders: { ...ZERO_STATUS_BREAKDOWN, domain: 'Buy/sell orders' },
  barter: { ...ZERO_STATUS_BREAKDOWN, domain: 'Barter trades' },
  rentToBuy: { ...ZERO_STATUS_BREAKDOWN, domain: 'Rent-to-Buy' },
  lookingFor: { ...ZERO_STATUS_BREAKDOWN, domain: 'Looking For requests' },
  revenueNote: 'not_available_mock_payment_provider',
}
const ZERO_TRUST: TrustAnalytics = {
  kycByStatus: [], ownershipVerificationByStatus: [],
  disputesByStatus: { ...ZERO_STATUS_BREAKDOWN, domain: 'Disputes', mayIncludeTestData: true },
  publishedReviews: 0, accountRestrictions: { restricted: 0, suspended: 0 },
}
const ZERO_GROWTH: GrowthAnalytics = { newUsers: ZERO_COMPARISON, newMerchants: ZERO_COMPARISON, newRealListings: ZERO_COMPARISON, newBookings: ZERO_COMPARISON, newOrders: ZERO_COMPARISON }
const ZERO_BEHAVIOR: BehaviorAnalytics = {
  pageViews: 0, searchStarted: 0, searchResultsViewed: 0, zeroResultSearches: 0, zeroResultRate: null, searchRefinements: 0, listingViews: 0,
  signupFunnel: { started: 0, completed: 0, conversionRate: null },
  listingCreationFunnel: { started: 0, completed: 0, conversionRate: null },
  rentalFunnel: { started: 0, completed: 0, conversionRate: null },
  orderFunnel: { started: 0, completed: 0, conversionRate: null },
  kycFunnel: { started: 0, completed: 0, conversionRate: null },
  dataQuality: { hasAnyEventData: false, mayIncludeUnclassifiedActivity: false, notes: ['note'] },
}
const ZERO_SUPPORT: SupportAnalytics = { byStatus: [], byPriority: [], byCategory: [], total: 0 }

function setupBaseline(overrides: {
  marketplace?: Partial<typeof ZERO_MARKETPLACE>
  supply?: Partial<typeof ZERO_SUPPLY>
  demand?: Partial<typeof ZERO_DEMAND>
  transactions?: Partial<typeof ZERO_TRANSACTIONS>
  trust?: Partial<typeof ZERO_TRUST>
  growth?: Partial<typeof ZERO_GROWTH>
  behavior?: Partial<typeof ZERO_BEHAVIOR>
  support?: Partial<typeof ZERO_SUPPORT>
  overviewStats?: Record<string, number> | null
  exceptions?: Array<{ severity: 'low' | 'medium' | 'high'; resolved: boolean }>
} = {}) {
  getMarketplaceOverview.mockResolvedValue({ ...ZERO_MARKETPLACE, ...overrides.marketplace })
  getSupplyAnalytics.mockResolvedValue({ ...ZERO_SUPPLY, ...overrides.supply })
  getDemandAnalytics.mockResolvedValue({ ...ZERO_DEMAND, ...overrides.demand })
  getTransactionAnalytics.mockResolvedValue({ ...ZERO_TRANSACTIONS, ...overrides.transactions })
  getTrustAnalytics.mockResolvedValue({ ...ZERO_TRUST, ...overrides.trust })
  getGrowthAnalytics.mockResolvedValue({ ...ZERO_GROWTH, ...overrides.growth })
  getBehaviorAnalytics.mockResolvedValue({ ...ZERO_BEHAVIOR, ...overrides.behavior })
  getSupportAnalytics.mockResolvedValue({ ...ZERO_SUPPORT, ...overrides.support })
  listOperationalExceptions.mockResolvedValue(overrides.exceptions ?? [])

  const overviewStats = overrides.overviewStats ?? {
    pending_kyc_reviews: 0, pending_ownership_reviews: 0, pending_listing_moderation: 0, failed_financial_workflows: 0, retryable_email_failures: 0,
  }
  return {
    rpc: vi.fn().mockResolvedValue({ data: overviewStats, error: null }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

beforeEach(() => {
  getMarketplaceOverview.mockReset()
  getSupplyAnalytics.mockReset()
  getDemandAnalytics.mockReset()
  getTransactionAnalytics.mockReset()
  getTrustAnalytics.mockReset()
  getGrowthAnalytics.mockReset()
  getBehaviorAnalytics.mockReset()
  getSupportAnalytics.mockReset()
  listOperationalExceptions.mockReset()
})

describe('getIntelligenceInsights: zero/sparse data state (category: ADMIN-CONTROL-CENTRE-BATCH-E1)', () => {
  it('1. a fully zero/sparse environment produces only data-quality insights, never a fabricated business insight', async () => {
    const admin = setupBaseline()
    const result = await getIntelligenceInsights(admin)
    expect(result.insights.length).toBeGreaterThan(0)
    expect(result.insights.every((i) => i.category === 'data-quality')).toBe(true)
  })

  it('2. the zero-data result still returns a well-formed, non-throwing summary', async () => {
    const admin = setupBaseline()
    const result = await getIntelligenceInsights(admin)
    expect(result.summary.totalInsights).toBe(result.insights.length)
    expect(result.summary.opportunities).toBe(0)
    expect(Number.isNaN(result.summary.totalInsights)).toBe(false)
  })

  it('3. no event data yet produces a dedicated data-quality insight and suppresses the Conversion-category insight (avoids a redundant/contradictory pair)', async () => {
    const admin = setupBaseline()
    const result = await getIntelligenceInsights(admin)
    expect(result.insights.some((i) => /no first-party behavioral event data/i.test(i.title))).toBe(true)
    expect(result.insights.some((i) => i.category === 'conversion')).toBe(false)
  })

  it('4. once event data exists, the Conversion category reports the structural "cannot be computed" finding rather than a fabricated conversion-collapse insight, even when completed counts are nonzero', async () => {
    const admin = setupBaseline({
      behavior: { ...ZERO_BEHAVIOR, dataQuality: { hasAnyEventData: true, mayIncludeUnclassifiedActivity: false, notes: ['note'] }, listingCreationFunnel: { started: 0, completed: 12, conversionRate: null } },
    })
    const result = await getIntelligenceInsights(admin)
    const conv = result.insights.find((i) => i.category === 'conversion')
    expect(conv).toBeDefined()
    expect(conv?.dataSufficiency).toBe('insufficient')
    expect(conv?.title).toMatch(/cannot currently be computed/i)
    expect(result.insights.some((i) => /collapse/i.test(i.title))).toBe(false)
  })
})

describe('getIntelligenceInsights: Growth trend rules (category: ADMIN-CONTROL-CENTRE-BATCH-E1)', () => {
  it('1. a swing below the previous-period floor produces no growth insight (too sparse to generalize from)', async () => {
    const admin = setupBaseline({ growth: { ...ZERO_GROWTH, newUsers: { current: 4, previous: 2 } } })
    const result = await getIntelligenceInsights(admin)
    expect(result.insights.some((i) => i.category === 'growth')).toBe(false)
  })

  it('2. a swing at/above the previous-period floor but below the growth-swing threshold produces no insight', async () => {
    const admin = setupBaseline({ growth: { ...ZERO_GROWTH, newUsers: { current: 11, previous: 10 } } }) // +10%, floor cleared, swing threshold (25%) not
    const result = await getIntelligenceInsights(admin)
    expect(result.insights.some((i) => i.category === 'growth')).toBe(false)
  })

  it('3. a qualifying positive swing produces an opportunity-type growth insight with real-data scope and evidence', async () => {
    const admin = setupBaseline({ growth: { ...ZERO_GROWTH, newUsers: { current: 20, previous: 10 } } }) // +100%
    const result = await getIntelligenceInsights(admin)
    const insight = result.insights.find((i) => i.category === 'growth' && /New users/i.test(i.title))
    expect(insight).toBeDefined()
    expect(insight?.type).toBe('opportunity')
    expect(insight?.scope).toBe('real-data')
    expect(insight?.evidence.length).toBeGreaterThan(0)
  })

  it('4. a qualifying negative swing produces a risk-type growth insight, never an opportunity', async () => {
    const admin = setupBaseline({ growth: { ...ZERO_GROWTH, newOrders: { current: 5, previous: 10 } } }) // -50%
    const result = await getIntelligenceInsights(admin)
    const insight = result.insights.find((i) => i.category === 'growth' && /New orders/i.test(i.title))
    expect(insight).toBeDefined()
    expect(insight?.type).toBe('risk')
  })

  it('5. a null previous period (e.g. "all" window / no comparable history) produces no growth insight -- never a fabricated 0->N "infinite" swing', async () => {
    const admin = setupBaseline({ growth: { ...ZERO_GROWTH, newMerchants: { current: 50, previous: null } } })
    const result = await getIntelligenceInsights(admin)
    expect(result.insights.some((i) => i.category === 'growth' && /merchant/i.test(i.title))).toBe(false)
  })
})

describe('getIntelligenceInsights: Supply/Demand and Trust rules require positive-proof real-data population floors (category: ADMIN-CONTROL-CENTRE-BATCH-E1)', () => {
  it('1. demand/supply insight is suppressed below the minimum real-listings floor even with a huge nominal demand ratio', async () => {
    const admin = setupBaseline({ marketplace: { ...ZERO_MARKETPLACE, realActiveListings: 2 }, demand: { ...ZERO_DEMAND, lookingFor: { byCategory: [], byStatus: [], total: 100 } } })
    const result = await getIntelligenceInsights(admin)
    expect(result.insights.some((i) => i.category === 'demand')).toBe(false)
  })

  it('2. demand/supply opportunity fires once both the listing floor and the demand ratio are cleared', async () => {
    const admin = setupBaseline({ marketplace: { ...ZERO_MARKETPLACE, realActiveListings: 20 }, demand: { ...ZERO_DEMAND, lookingFor: { byCategory: [], byStatus: [], total: 50 } } })
    const result = await getIntelligenceInsights(admin)
    const insight = result.insights.find((i) => i.category === 'demand')
    expect(insight).toBeDefined()
    expect(insight?.type).toBe('opportunity')
    expect(insight?.scope).toBe('real-data')
  })

  it('3. account restriction watch insight is suppressed below the floor', async () => {
    const admin = setupBaseline({ trust: { ...ZERO_TRUST, accountRestrictions: { restricted: 1, suspended: 1 } } })
    const result = await getIntelligenceInsights(admin)
    expect(result.insights.some((i) => i.category === 'trust' && /restricted/i.test(i.title))).toBe(false)
  })

  it('4. account restriction watch insight fires once the floor is cleared, using only real-filtered counts', async () => {
    const admin = setupBaseline({ trust: { ...ZERO_TRUST, accountRestrictions: { restricted: 2, suspended: 2 } } })
    const result = await getIntelligenceInsights(admin)
    const insight = result.insights.find((i) => i.category === 'trust' && /restricted/i.test(i.title))
    expect(insight).toBeDefined()
    expect(insight?.scope).toBe('real-data')
    expect(insight?.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Restricted (real)', value: 2 })]))
  })

  it('5. disputes never produce a Trust risk/watch insight -- only an honest data-quality caveat, since no reliable real-only exclusion exists for disputes', async () => {
    const admin = setupBaseline({ trust: { ...ZERO_TRUST, disputesByStatus: { domain: 'Disputes', total: 500, byStatus: [{ label: 'open', count: 500 }], mayIncludeTestData: true } } })
    const result = await getIntelligenceInsights(admin)
    expect(result.insights.some((i) => i.category === 'trust')).toBe(false)
    expect(result.insights.some((i) => i.category === 'data-quality' && /dispute/i.test(i.title))).toBe(true)
  })
})

describe('getIntelligenceInsights: Operations (all-system) insights (category: ADMIN-CONTROL-CENTRE-BATCH-E1)', () => {
  it('1. an operational backlog below the watch floor produces no insight', async () => {
    const admin = setupBaseline({ overviewStats: { pending_kyc_reviews: 3, pending_ownership_reviews: 0, pending_listing_moderation: 0, failed_financial_workflows: 0, retryable_email_failures: 0 } })
    const result = await getIntelligenceInsights(admin)
    expect(result.insights.some((i) => i.category === 'operations')).toBe(false)
  })

  it('2. a KYC review backlog at/above the watch floor (but below the high floor) produces a medium-priority watch insight scoped operational-all-system', async () => {
    const admin = setupBaseline({ overviewStats: { pending_kyc_reviews: 15, pending_ownership_reviews: 0, pending_listing_moderation: 0, failed_financial_workflows: 0, retryable_email_failures: 0 } })
    const result = await getIntelligenceInsights(admin)
    const insight = result.insights.find((i) => i.category === 'operations' && /KYC review/i.test(i.title))
    expect(insight).toBeDefined()
    expect(insight?.type).toBe('watch')
    expect(insight?.priority).toBe('medium')
    expect(insight?.scope).toBe('operational-all-system')
  })

  it('3. a backlog at/above the high floor is escalated to a high-priority risk', async () => {
    const admin = setupBaseline({ overviewStats: { pending_kyc_reviews: 0, pending_ownership_reviews: 0, pending_listing_moderation: 40, failed_financial_workflows: 0, retryable_email_failures: 0 } })
    const result = await getIntelligenceInsights(admin)
    const insight = result.insights.find((i) => i.category === 'operations' && /moderation/i.test(i.title))
    expect(insight).toBeDefined()
    expect(insight?.type).toBe('risk')
    expect(insight?.priority).toBe('high')
  })

  it('4. Support open-case backlog excludes resolved/closed cases from the count', async () => {
    const admin = setupBaseline({
      support: { total: 100, byStatus: [{ label: 'open', count: 12 }, { label: 'resolved', count: 80 }, { label: 'closed', count: 8 }], byPriority: [], byCategory: [] },
    })
    const result = await getIntelligenceInsights(admin)
    const insight = result.insights.find((i) => i.category === 'operations' && /Support/i.test(i.title))
    expect(insight).toBeDefined()
    expect(insight?.evidence[0]).toMatchObject({ value: 12 })
  })

  it('5. exceptions queue depth counts only unresolved items, and surfaces high-severity count in the rationale when present', async () => {
    const admin = setupBaseline({
      exceptions: [
        { severity: 'high', resolved: false }, { severity: 'high', resolved: false }, { severity: 'low', resolved: false },
        ...Array.from({ length: 12 }, () => ({ severity: 'low' as const, resolved: false })),
        { severity: 'high', resolved: true }, // resolved -- must not count
      ],
    })
    const result = await getIntelligenceInsights(admin)
    const insight = result.insights.find((i) => i.category === 'operations' && /Exceptions/i.test(i.title))
    expect(insight).toBeDefined()
    expect(insight?.evidence[0]).toMatchObject({ value: 15 }) // 15 unresolved, the 1 resolved high-severity row excluded
    expect(insight?.rationale).toMatch(/2 marked high severity/)
  })

  it('6. a missing/null Overview RPC result does not throw and simply omits those 5 fields\' insights', async () => {
    const admin = setupBaseline()
    admin.rpc = vi.fn().mockResolvedValue({ data: null, error: null })
    const result = await getIntelligenceInsights(admin)
    expect(result.insights.filter((i) => i.category === 'operations' && /KYC review|ownership|moderation|financial workflow|email failure/i.test(i.title))).toHaveLength(0)
  })
})

describe('getIntelligenceInsights: deterministic ordering (category: ADMIN-CONTROL-CENTRE-BATCH-E1)', () => {
  it('1. insights are ordered by priority (high, then medium, then low) regardless of which rule generated them', async () => {
    const admin = setupBaseline({
      growth: { ...ZERO_GROWTH, newUsers: { current: 20, previous: 10 } }, // medium opportunity
      overviewStats: { pending_kyc_reviews: 40, pending_ownership_reviews: 0, pending_listing_moderation: 0, failed_financial_workflows: 0, retryable_email_failures: 0 }, // high risk
    })
    const result = await getIntelligenceInsights(admin)
    const priorities = result.insights.map((i) => i.priority)
    const firstMediumIdx = priorities.indexOf('medium')
    const firstHighIdx = priorities.indexOf('high')
    expect(firstHighIdx).toBeLessThan(firstMediumIdx === -1 ? Infinity : firstMediumIdx)
  })

  it('2. running the computation twice against identical input data produces an identical insight ordering and content (ids aside)', async () => {
    const admin1 = setupBaseline({ growth: { ...ZERO_GROWTH, newUsers: { current: 20, previous: 10 } } })
    const result1 = await getIntelligenceInsights(admin1)
    const admin2 = setupBaseline({ growth: { ...ZERO_GROWTH, newUsers: { current: 20, previous: 10 } } })
    const result2 = await getIntelligenceInsights(admin2)
    const strip = (r: typeof result1) => r.insights.map((i) => ({ category: i.category, type: i.type, priority: i.priority, title: i.title }))
    expect(strip(result1)).toEqual(strip(result2))
  })
})

describe('getIntelligenceInsights: privacy -- no PII is ever emitted (category: ADMIN-CONTROL-CENTRE-BATCH-E1)', () => {
  it('1. no insight exposes an email address, phone number, legal name, or raw UUID-shaped identifier anywhere in its text fields', async () => {
    const admin = setupBaseline({
      growth: { ...ZERO_GROWTH, newUsers: { current: 20, previous: 10 } },
      trust: { ...ZERO_TRUST, accountRestrictions: { restricted: 3, suspended: 3 }, kycByStatus: [{ label: 'approved', count: 10 }] },
      marketplace: { ...ZERO_MARKETPLACE, realActiveListings: 20 },
      demand: { ...ZERO_DEMAND, lookingFor: { byCategory: [], byStatus: [], total: 50 } },
      overviewStats: { pending_kyc_reviews: 40, pending_ownership_reviews: 0, pending_listing_moderation: 0, failed_financial_workflows: 0, retryable_email_failures: 0 },
      exceptions: Array.from({ length: 15 }, () => ({ severity: 'low' as const, resolved: false })),
    })
    const result = await getIntelligenceInsights(admin)
    // E3's own fingerprint is an intentional SHA-256 hex digest (see
    // computeInsightFingerprint) -- it is expected, by construction, to
    // contain long runs of digits and hex-shaped substrings as a pure
    // hashing artifact, so it is excluded here, not because it might
    // hide PII (it structurally cannot -- see the dedicated E3
    // fingerprint-privacy test below) but because the digit-run/uuid-shape
    // regexes below are tuned to catch real phone numbers/UUIDs in
    // narrative text fields, not a 64-char hash.
    const blob = JSON.stringify(result.insights.map((i) => Object.fromEntries(Object.entries(i).filter(([key]) => key !== 'fingerprint'))))
    expect(blob).not.toMatch(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i) // email shape
    expect(blob).not.toMatch(/\+?\d{9,}/) // phone-length digit run
    expect(blob).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) // raw uuid
  })
})

describe('getIntelligenceInsights: structural safety (category: ADMIN-CONTROL-CENTRE-BATCH-E1)', () => {
  it('1. no insight recommendation text names or implies an automated mutating action', async () => {
    const admin = setupBaseline({
      growth: { ...ZERO_GROWTH, newUsers: { current: 20, previous: 10 }, newOrders: { current: 5, previous: 10 } },
      overviewStats: { pending_kyc_reviews: 40, pending_ownership_reviews: 0, pending_listing_moderation: 0, failed_financial_workflows: 0, retryable_email_failures: 0 },
    })
    const result = await getIntelligenceInsights(admin)
    const forbidden = /\b(ban|suspend(ed)?|approve|reject|refund|capture payment|release payout|change(d)? pric|send email|contact user)\b/i
    for (const insight of result.insights) {
      expect(forbidden.test(insight.recommendation), `"${insight.recommendation}" should not imply an automated action`).toBe(false)
      expect(insight).not.toHaveProperty('actionType')
      expect(insight).not.toHaveProperty('mutationEndpoint')
    }
  })

  it('2. the admin never issues a write query -- only the mocked read-only analytics/exceptions functions and one RPC read are called', async () => {
    const admin = setupBaseline()
    await getIntelligenceInsights(admin)
    expect(getMarketplaceOverview).toHaveBeenCalled()
    expect(listOperationalExceptions).toHaveBeenCalled()
    expect(admin.rpc).toHaveBeenCalledWith('get_admin_overview_stats')
    expect(admin.rpc).not.toHaveBeenCalledWith(expect.stringMatching(/^(update|delete|insert|approve|reject|resolve)/i))
  })

  it('3. every insight carries a non-empty recommendation, confidence, dataSufficiency, and scope', async () => {
    const admin = setupBaseline({ growth: { ...ZERO_GROWTH, newUsers: { current: 20, previous: 10 } } })
    const result = await getIntelligenceInsights(admin)
    for (const insight of result.insights) {
      expect(insight.recommendation.length).toBeGreaterThan(0)
      expect(['high', 'medium', 'low']).toContain(insight.confidence)
      expect(['sufficient', 'limited', 'insufficient']).toContain(insight.dataSufficiency)
      expect(['real-data', 'operational-all-system']).toContain(insight.scope)
    }
  })
})

describe('getIntelligenceInsights: failure isolation (category: ADMIN-CONTROL-CENTRE-BATCH-E1-F1)', () => {
  it('A1. a single rejecting source does not reject the overall result, and other sources still contribute their own insights normally', async () => {
    const admin = setupBaseline({ growth: { ...ZERO_GROWTH, newUsers: { current: 20, previous: 10 } } })
    getMarketplaceOverview.mockRejectedValue(new Error('connection reset'))
    const result = await getIntelligenceInsights(admin)
    expect(result).toBeDefined()
    expect(result.insights.some((i) => i.category === 'growth' && /New users/i.test(i.title))).toBe(true)
  })

  it('A2. a failed source produces a dedicated degraded-source finding naming it by human-readable label, never a raw error message, stack trace, or table name', async () => {
    const admin = setupBaseline()
    getMarketplaceOverview.mockRejectedValue(new Error('pg_catalog.unity_profiles_tbl_7f3a ECONNRESET at host 10.0.0.5:5432'))
    const result = await getIntelligenceInsights(admin)
    const degraded = result.insights.find((i) => /partially unavailable/i.test(i.title))
    expect(degraded).toBeDefined()
    expect(degraded?.category).toBe('data-quality')
    expect(degraded?.evidence.some((e) => /Marketplace analytics/i.test(String(e.label)))).toBe(true)
    const blob = JSON.stringify(result.insights)
    expect(blob).not.toMatch(/pg_catalog|unity_profiles_tbl|ECONNRESET|10\.0\.0\.5/)
  })

  it('A3. a failed source is never silently substituted with a genuine-zero value -- the "small real user base" insight (keyed off an observed totalUsers=0) does not fire when marketplace actually failed to load', async () => {
    const admin = setupBaseline()
    getMarketplaceOverview.mockRejectedValue(new Error('timeout'))
    const result = await getIntelligenceInsights(admin)
    expect(result.insights.some((i) => /confirmed Real Data user base is still small/i.test(i.title))).toBe(false)
  })

  it('A4. a failed source does not suppress an unrelated successful source\'s operational insight', async () => {
    const admin = setupBaseline({ overviewStats: { pending_kyc_reviews: 40, pending_ownership_reviews: 0, pending_listing_moderation: 0, failed_financial_workflows: 0, retryable_email_failures: 0 } })
    getBehaviorAnalytics.mockRejectedValue(new Error('boom'))
    const result = await getIntelligenceInsights(admin)
    expect(result.insights.some((i) => i.category === 'operations' && /KYC review/i.test(i.title))).toBe(true)
  })
})

describe('getIntelligenceInsights: Admin Overview protection -- Intelligence failure cannot break Overview rendering (category: ADMIN-CONTROL-CENTRE-BATCH-E1-F1)', () => {
  it('B1. getIntelligenceInsights never rejects even when every single input source rejects', async () => {
    const admin = setupBaseline()
    getMarketplaceOverview.mockRejectedValue(new Error('x'))
    getSupplyAnalytics.mockRejectedValue(new Error('x'))
    getDemandAnalytics.mockRejectedValue(new Error('x'))
    getTransactionAnalytics.mockRejectedValue(new Error('x'))
    getTrustAnalytics.mockRejectedValue(new Error('x'))
    getGrowthAnalytics.mockRejectedValue(new Error('x'))
    getBehaviorAnalytics.mockRejectedValue(new Error('x'))
    getSupportAnalytics.mockRejectedValue(new Error('x'))
    listOperationalExceptions.mockRejectedValue(new Error('x'))
    admin.rpc = vi.fn().mockRejectedValue(new Error('x'))
    await expect(getIntelligenceInsights(admin)).resolves.toBeDefined()
  })

  it('B2. a total source outage still returns a well-formed result with a high-priority degraded-source finding, so a caller awaiting this promise (e.g. the Admin Overview page\'s own Promise.all) is never the cause of a rejected page render', async () => {
    const admin = setupBaseline()
    getMarketplaceOverview.mockRejectedValue(new Error('x'))
    getSupplyAnalytics.mockRejectedValue(new Error('x'))
    getDemandAnalytics.mockRejectedValue(new Error('x'))
    getTransactionAnalytics.mockRejectedValue(new Error('x'))
    getTrustAnalytics.mockRejectedValue(new Error('x'))
    getGrowthAnalytics.mockRejectedValue(new Error('x'))
    getBehaviorAnalytics.mockRejectedValue(new Error('x'))
    getSupportAnalytics.mockRejectedValue(new Error('x'))
    listOperationalExceptions.mockRejectedValue(new Error('x'))
    admin.rpc = vi.fn().mockRejectedValue(new Error('x'))
    const result = await getIntelligenceInsights(admin)
    expect(result.summary).toBeDefined()
    expect(Array.isArray(result.insights)).toBe(true)
    const degraded = result.insights.find((i) => /partially unavailable/i.test(i.title))
    expect(degraded?.priority).toBe('high')
  })
})

describe('getIntelligenceInsights: multiple simultaneous source failures (category: ADMIN-CONTROL-CENTRE-BATCH-E1-F1)', () => {
  it('C1. several sources failing at once still produces a valid result with no NaN/undefined/Infinity anywhere in the output', async () => {
    const admin = setupBaseline()
    getSupplyAnalytics.mockRejectedValue(new Error('x'))
    getDemandAnalytics.mockRejectedValue(new Error('x'))
    getTrustAnalytics.mockRejectedValue(new Error('x'))
    const result = await getIntelligenceInsights(admin)
    expect(Number.isNaN(result.summary.totalInsights)).toBe(false)
    expect(Number.isNaN(result.summary.highPriority)).toBe(false)
    expect(Number.isFinite(result.summary.totalInsights)).toBe(true)
    const blob = JSON.stringify(result)
    expect(blob).not.toMatch(/\bNaN\b|\bundefined\b|\bInfinity\b/)
  })

  it('C2. the single degraded-source finding names every one of several simultaneously failed sources', async () => {
    const admin = setupBaseline()
    getSupplyAnalytics.mockRejectedValue(new Error('x'))
    getDemandAnalytics.mockRejectedValue(new Error('x'))
    getTrustAnalytics.mockRejectedValue(new Error('x'))
    const result = await getIntelligenceInsights(admin)
    const degraded = result.insights.find((i) => /partially unavailable/i.test(i.title))
    expect(degraded).toBeDefined()
    expect(degraded?.evidence.length).toBe(3)
    expect(degraded?.evidence.some((e) => /Supply analytics/i.test(String(e.label)))).toBe(true)
    expect(degraded?.evidence.some((e) => /Demand analytics/i.test(String(e.label)))).toBe(true)
    expect(degraded?.evidence.some((e) => /Trust analytics/i.test(String(e.label)))).toBe(true)
  })

  it('C3. exactly reaching the degraded-source high-priority count escalates the finding to high priority; below it stays medium', async () => {
    const admin1 = setupBaseline()
    getSupplyAnalytics.mockRejectedValue(new Error('x'))
    const result1 = await getIntelligenceInsights(admin1)
    expect(result1.insights.find((i) => /partially unavailable/i.test(i.title))?.priority).toBe('medium')

    const admin2 = setupBaseline()
    getSupplyAnalytics.mockRejectedValue(new Error('x'))
    getDemandAnalytics.mockRejectedValue(new Error('x'))
    getTrustAnalytics.mockRejectedValue(new Error('x'))
    const result2 = await getIntelligenceInsights(admin2)
    expect(result2.insights.find((i) => /partially unavailable/i.test(i.title))?.priority).toBe('high')
  })
})

describe('getIntelligenceInsights: priority/confidence coherence clamp (category: ADMIN-CONTROL-CENTRE-BATCH-E1-F1)', () => {
  it('D1. previous=5/current=8 (+60%, a thin-sample swing) must NOT reach high priority -- it is both below the sufficiency floor and low-confidence', async () => {
    const admin = setupBaseline({ growth: { ...ZERO_GROWTH, newUsers: { current: 8, previous: 5 } } })
    const result = await getIntelligenceInsights(admin)
    const insight = result.insights.find((i) => i.category === 'growth' && /New users/i.test(i.title))
    expect(insight).toBeDefined()
    expect(insight?.dataSufficiency).not.toBe('sufficient')
    expect(insight?.confidence).toBe('low')
    expect(insight?.priority).not.toBe('high')
  })

  it('D2. a sufficiently sampled, high-confidence swing can still reach high priority -- the clamp does not globally block it', async () => {
    const admin = setupBaseline({ growth: { ...ZERO_GROWTH, newUsers: { current: 100, previous: 50 } } }) // +100%, previous >= MIN_REAL_PROFILES_FOR_TREND
    const result = await getIntelligenceInsights(admin)
    const insight = result.insights.find((i) => i.category === 'growth' && /New users/i.test(i.title))
    expect(insight).toBeDefined()
    expect(insight?.dataSufficiency).toBe('sufficient')
    expect(insight?.priority).toBe('high')
  })

  it('D3. the clamp never downgrades an operational-all-system backlog finding, even from a small/low-confidence sample', async () => {
    const admin = setupBaseline({ overviewStats: { pending_kyc_reviews: 0, pending_ownership_reviews: 0, pending_listing_moderation: 40, failed_financial_workflows: 0, retryable_email_failures: 0 } })
    const result = await getIntelligenceInsights(admin)
    const insight = result.insights.find((i) => i.category === 'operations' && /moderation/i.test(i.title))
    expect(insight?.priority).toBe('high')
  })

  it('D4. the clamp never downgrades a data-quality finding (it can legitimately be high priority precisely because business data is thin)', async () => {
    const admin = setupBaseline()
    getMarketplaceOverview.mockRejectedValue(new Error('x'))
    getSupplyAnalytics.mockRejectedValue(new Error('x'))
    getDemandAnalytics.mockRejectedValue(new Error('x'))
    const result = await getIntelligenceInsights(admin)
    const degraded = result.insights.find((i) => /partially unavailable/i.test(i.title))
    expect(degraded?.category).toBe('data-quality')
    expect(degraded?.priority).toBe('high')
  })
})

describe('getIntelligenceInsights: homepage scope-aware summary (category: ADMIN-CONTROL-CENTRE-BATCH-E1-F1)', () => {
  it('E1. realData and operational summary counts are reported separately, not blended into one scope-blind total', async () => {
    const admin = setupBaseline({
      growth: { ...ZERO_GROWTH, newUsers: { current: 100, previous: 50 } }, // real-data, high priority
      overviewStats: { pending_kyc_reviews: 0, pending_ownership_reviews: 0, pending_listing_moderation: 40, failed_financial_workflows: 0, retryable_email_failures: 0 }, // operational, high priority
    })
    const result = await getIntelligenceInsights(admin)
    expect(result.summary.realData.highPriority).toBe(1)
    expect(result.summary.operational.highPriority).toBe(1)
    expect(result.summary.highPriority).toBe(2)
  })

  it('E2. an operational-only high-priority insight does not increment the realData.highPriority count', async () => {
    const admin = setupBaseline({
      overviewStats: { pending_kyc_reviews: 0, pending_ownership_reviews: 0, pending_listing_moderation: 40, failed_financial_workflows: 0, retryable_email_failures: 0 },
    })
    const result = await getIntelligenceInsights(admin)
    expect(result.summary.operational.highPriority).toBeGreaterThan(0)
    expect(result.summary.realData.highPriority).toBe(0)
  })

  it('E3. realData.opportunities only counts real-data-scoped opportunity insights', async () => {
    const admin = setupBaseline({
      marketplace: { ...ZERO_MARKETPLACE, realActiveListings: 20 },
      demand: { ...ZERO_DEMAND, lookingFor: { byCategory: [], byStatus: [], total: 50 } },
    })
    const result = await getIntelligenceInsights(admin)
    const demandInsight = result.insights.find((i) => i.category === 'demand')
    expect(demandInsight?.scope).toBe('real-data')
    expect(demandInsight?.type).toBe('opportunity')
    expect(result.summary.realData.opportunities).toBeGreaterThanOrEqual(1)
  })
})

describe('getIntelligenceInsights: E2 stable rule IDs (category: ADMIN-CONTROL-CENTRE-BATCH-E2)', () => {
  it('A1. identical inputs generate identical rule IDs across repeated calls', async () => {
    const admin1 = setupBaseline({ growth: { ...ZERO_GROWTH, newUsers: { current: 20, previous: 10 } } })
    const result1 = await getIntelligenceInsights(admin1)
    const admin2 = setupBaseline({ growth: { ...ZERO_GROWTH, newUsers: { current: 20, previous: 10 } } })
    const result2 = await getIntelligenceInsights(admin2)
    expect(result1.insights.map((i) => i.ruleId).sort()).toEqual(result2.insights.map((i) => i.ruleId).sort())
  })

  it('A2. no two distinct rule families share the same rule ID -- RULE_IDS values are all unique', () => {
    const values = Object.values(RULE_IDS)
    expect(new Set(values).size).toBe(values.length)
  })

  it('A3. every rule ID has exactly one RULE_REGISTRY entry, and every registry entry is a real rule ID', () => {
    const ruleIdValues = new Set(Object.values(RULE_IDS) as string[])
    expect(new Set(Object.keys(RULE_REGISTRY))).toEqual(ruleIdValues)
  })

  it('A4. rule IDs are stable human-readable strings, never UUIDs or numeric database IDs', async () => {
    const admin = setupBaseline({ growth: { ...ZERO_GROWTH, newUsers: { current: 20, previous: 10 } } })
    const result = await getIntelligenceInsights(admin)
    for (const insight of result.insights) {
      expect(insight.ruleId).toMatch(/^[A-Z][A-Z0-9_]+$/)
      expect(insight.ruleId).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
    }
  })

  it('A5. distinct growth directions (up vs down) for the same metric produce distinct rule IDs', async () => {
    const adminUp = setupBaseline({ growth: { ...ZERO_GROWTH, newUsers: { current: 20, previous: 10 } } })
    const resultUp = await getIntelligenceInsights(adminUp)
    const adminDown = setupBaseline({ growth: { ...ZERO_GROWTH, newUsers: { current: 5, previous: 10 } } })
    const resultDown = await getIntelligenceInsights(adminDown)
    const upRuleId = resultUp.insights.find((i) => i.category === 'growth' && /New users/i.test(i.title))?.ruleId
    const downRuleId = resultDown.insights.find((i) => i.category === 'growth' && /New users/i.test(i.title))?.ruleId
    expect(upRuleId).toBe(RULE_IDS.GROWTH_NEW_USERS_UP)
    expect(downRuleId).toBe(RULE_IDS.GROWTH_NEW_USERS_DOWN)
    expect(upRuleId).not.toBe(downRuleId)
  })
})

describe('getIntelligenceInsights: E2 trigger explainability (category: ADMIN-CONTROL-CENTRE-BATCH-E2)', () => {
  it('B1. a business insight includes its triggering metric and observed/threshold values', async () => {
    const admin = setupBaseline({ growth: { ...ZERO_GROWTH, newUsers: { current: 20, previous: 10 } } })
    const result = await getIntelligenceInsights(admin)
    const insight = result.insights.find((i) => i.category === 'growth' && /New users/i.test(i.title))
    expect(insight?.trigger).toBeDefined()
    expect(insight?.trigger?.metric).toMatch(/New users/i)
    expect(insight?.trigger?.observedValue).toBeDefined()
    expect(insight?.trigger?.thresholdValue).toBeDefined()
  })

  it('B2. an operational backlog insight surfaces its threshold', async () => {
    const admin = setupBaseline({ overviewStats: { pending_kyc_reviews: 15, pending_ownership_reviews: 0, pending_listing_moderation: 0, failed_financial_workflows: 0, retryable_email_failures: 0 } })
    const result = await getIntelligenceInsights(admin)
    const insight = result.insights.find((i) => i.category === 'operations' && /KYC review/i.test(i.title))
    expect(insight?.trigger?.observedValue).toBe(15)
    expect(insight?.trigger?.thresholdValue).toBeDefined()
  })

  it('B3. no insight contains a hidden undefined/NaN value anywhere in its serialized form', async () => {
    const admin = setupBaseline({
      growth: { ...ZERO_GROWTH, newUsers: { current: 20, previous: 10 } },
      overviewStats: { pending_kyc_reviews: 40, pending_ownership_reviews: 0, pending_listing_moderation: 0, failed_financial_workflows: 0, retryable_email_failures: 0 },
    })
    const result = await getIntelligenceInsights(admin)
    const blob = JSON.stringify(result)
    expect(blob).not.toMatch(/\bNaN\b|\bundefined\b/)
  })
})

describe('getIntelligenceInsights: E2 source health diagnostics (category: ADMIN-CONTROL-CENTRE-BATCH-E2)', () => {
  it('C1. a healthy source appears available in sourceHealth', async () => {
    const admin = setupBaseline()
    const result = await getIntelligenceInsights(admin)
    const marketplaceRow = result.sourceHealth.find((s) => s.source === 'marketplace')
    expect(marketplaceRow?.status).toBe('available')
  })

  it('C2. a failed source appears degraded in sourceHealth, with no raw exception text', async () => {
    const admin = setupBaseline()
    getGrowthAnalytics.mockRejectedValue(new Error('pg_catalog.unity_growth_tbl_9c2 ECONNRESET'))
    const result = await getIntelligenceInsights(admin)
    const growthRow = result.sourceHealth.find((s) => s.source === 'growth')
    expect(growthRow?.status).toBe('degraded')
    const blob = JSON.stringify(result.sourceHealth)
    expect(blob).not.toMatch(/pg_catalog|unity_growth_tbl|ECONNRESET/)
  })

  it('C3. a degraded source correctly reports the rule families it affects', async () => {
    const admin = setupBaseline()
    getGrowthAnalytics.mockRejectedValue(new Error('x'))
    const result = await getIntelligenceInsights(admin)
    const growthRow = result.sourceHealth.find((s) => s.source === 'growth')
    expect(growthRow?.usedBy).toContain(RULE_IDS.GROWTH_NEW_USERS_UP)
    expect(growthRow?.usedBy).toContain(RULE_IDS.GROWTH_NEW_ORDERS_DOWN)
  })

  it('C4. sourceHealth always lists all 10 sources regardless of which insights fired this cycle', async () => {
    const admin = setupBaseline()
    const result = await getIntelligenceInsights(admin)
    expect(result.sourceHealth).toHaveLength(10)
    expect(result.sourceHealth.every((s) => s.status === 'available')).toBe(true)
  })
})

describe('getIntelligenceInsights: E2 limitations (category: ADMIN-CONTROL-CENTRE-BATCH-E2)', () => {
  it('D1. a sparse-sample growth insight exposes a limitation about sample sufficiency', async () => {
    const admin = setupBaseline({ growth: { ...ZERO_GROWTH, newUsers: { current: 8, previous: 5 } } })
    const result = await getIntelligenceInsights(admin)
    const insight = result.insights.find((i) => i.category === 'growth' && /New users/i.test(i.title))
    expect(insight?.limitations.length).toBeGreaterThan(0)
  })

  it('D2. a sufficiently sampled growth insight carries no sufficiency limitation', async () => {
    const admin = setupBaseline({ growth: { ...ZERO_GROWTH, newUsers: { current: 100, previous: 50 } } })
    const result = await getIntelligenceInsights(admin)
    const insight = result.insights.find((i) => i.category === 'growth' && /New users/i.test(i.title))
    expect(insight?.limitations).toEqual([])
  })

  it('D3. the degraded-source insight exposes a limitation about reduced source coverage', async () => {
    const admin = setupBaseline()
    getMarketplaceOverview.mockRejectedValue(new Error('x'))
    const result = await getIntelligenceInsights(admin)
    const degraded = result.insights.find((i) => /partially unavailable/i.test(i.title))
    expect(degraded?.limitations.length).toBeGreaterThan(0)
  })

  it('D4. an operational-all-system backlog insight clearly represents the operational-scope limitation', async () => {
    const admin = setupBaseline({ overviewStats: { pending_kyc_reviews: 40, pending_ownership_reviews: 0, pending_listing_moderation: 0, failed_financial_workflows: 0, retryable_email_failures: 0 } })
    const result = await getIntelligenceInsights(admin)
    const insight = result.insights.find((i) => i.category === 'operations' && /KYC review/i.test(i.title))
    expect(insight?.limitations.some((l) => /operational/i.test(l))).toBe(true)
  })
})

describe('getIntelligenceInsights: E2-F1 freshness semantics -- period vs snapshot vs structural (category: ADMIN-CONTROL-CENTRE-BATCH-E2-F1)', () => {
  it('E1. every insight carries a valid generatedAt timestamp', async () => {
    const admin = setupBaseline({ growth: { ...ZERO_GROWTH, newUsers: { current: 20, previous: 10 } } })
    const result = await getIntelligenceInsights(admin)
    for (const insight of result.insights) {
      expect(Number.isNaN(new Date(insight.freshness.generatedAt).getTime())).toBe(false)
    }
  })

  it('A. a genuine period-based growth insight carries evidenceBasis=period and sourceWindow="Last 30 days"', async () => {
    const admin = setupBaseline({ growth: { ...ZERO_GROWTH, newUsers: { current: 20, previous: 10 } } })
    const result = await getIntelligenceInsights(admin)
    const insight = result.insights.find((i) => i.category === 'growth' && /New users/i.test(i.title))
    expect(insight?.freshness.evidenceBasis).toBe('period')
    expect(insight?.freshness.sourceWindow).toBe('Last 30 days')
  })

  it('B. an operational backlog (snapshot) insight does NOT claim a "Last 30 days" window', async () => {
    const admin = setupBaseline({ overviewStats: { pending_kyc_reviews: 40, pending_ownership_reviews: 0, pending_listing_moderation: 0, failed_financial_workflows: 0, retryable_email_failures: 0 } })
    const result = await getIntelligenceInsights(admin)
    const insight = result.insights.find((i) => i.category === 'operations' && /KYC review/i.test(i.title))
    expect(insight?.freshness.evidenceBasis).toBe('snapshot')
    expect(insight?.freshness.sourceWindow).toBeUndefined()
  })

  it('B2. every one of the 7 Operations backlog rule families is classified snapshot, never period', async () => {
    const admin = setupBaseline({
      support: { total: 50, byStatus: [{ label: 'open', count: 15 }], byPriority: [], byCategory: [] },
      overviewStats: { pending_kyc_reviews: 15, pending_ownership_reviews: 15, pending_listing_moderation: 15, failed_financial_workflows: 15, retryable_email_failures: 15 },
      exceptions: Array.from({ length: 15 }, () => ({ severity: 'low' as const, resolved: false })),
    })
    const result = await getIntelligenceInsights(admin)
    const operationsInsights = result.insights.filter((i) => i.category === 'operations')
    expect(operationsInsights.length).toBe(7)
    for (const insight of operationsInsights) {
      expect(insight.freshness.evidenceBasis).toBe('snapshot')
      expect(insight.freshness.sourceWindow).toBeUndefined()
    }
  })

  it('C. TRUST_ACCOUNT_RESTRICTIONS and TRUST_KYC_STATUS_MIX are classified snapshot, not period', async () => {
    const admin = setupBaseline({
      trust: { ...ZERO_TRUST, accountRestrictions: { restricted: 2, suspended: 2 }, kycByStatus: [{ label: 'approved', count: 10 }] },
    })
    const result = await getIntelligenceInsights(admin)
    const restrictions = result.insights.find((i) => i.category === 'trust' && /restricted/i.test(i.title))
    const kycMix = result.insights.find((i) => i.category === 'trust' && /KYC status mix/i.test(i.title))
    expect(restrictions?.freshness.evidenceBasis).toBe('snapshot')
    expect(restrictions?.freshness.sourceWindow).toBeUndefined()
    expect(kycMix?.freshness.evidenceBasis).toBe('snapshot')
    expect(kycMix?.freshness.sourceWindow).toBeUndefined()
  })

  it('C2. TRUST_REVIEWS_SPARSE (genuinely since()-filtered on both sides) is classified period', async () => {
    const admin = setupBaseline({
      trust: { ...ZERO_TRUST, publishedReviews: 0 },
      transactions: { ...ZERO_TRANSACTIONS, bookings: { ...ZERO_TRANSACTIONS.bookings, total: 10 } },
    })
    const result = await getIntelligenceInsights(admin)
    const sparse = result.insights.find((i) => i.category === 'trust' && /sparse/i.test(i.title))
    expect(sparse?.freshness.evidenceBasis).toBe('period')
    expect(sparse?.freshness.sourceWindow).toBe('Last 30 days')
  })

  it('D. the degraded-source finding (structural) is never labeled as a 30-day window', async () => {
    const admin = setupBaseline()
    getMarketplaceOverview.mockRejectedValue(new Error('x'))
    const result = await getIntelligenceInsights(admin)
    const degraded = result.insights.find((i) => /partially unavailable/i.test(i.title))
    expect(degraded?.freshness.evidenceBasis).toBe('structural')
    expect(degraded?.freshness.sourceWindow).toBeUndefined()
  })

  it('D2. the funnel structural-telemetry-limitation finding is never labeled as a 30-day window', async () => {
    const admin = setupBaseline({
      behavior: { ...ZERO_BEHAVIOR, dataQuality: { hasAnyEventData: true, mayIncludeUnclassifiedActivity: false, notes: ['note'] } },
    })
    const result = await getIntelligenceInsights(admin)
    const conv = result.insights.find((i) => i.category === 'conversion')
    expect(conv?.freshness.evidenceBasis).toBe('structural')
    expect(conv?.freshness.sourceWindow).toBeUndefined()
  })
})

describe('getIntelligenceInsights: E2-F1 trend trigger sign consistency (category: ADMIN-CONTROL-CENTRE-BATCH-E2-F1)', () => {
  it('a rising (+60%) trend trigger shows a positive observed value and a positive signed threshold', async () => {
    const admin = setupBaseline({ growth: { ...ZERO_GROWTH, newUsers: { current: 100, previous: 50 } } })
    const result = await getIntelligenceInsights(admin)
    const insight = result.insights.find((i) => i.category === 'growth' && /New users/i.test(i.title))
    expect(insight?.trigger?.operator).toBe('>=')
    expect(insight?.trigger?.observedValue).toBe('+100%')
    expect(insight?.trigger?.thresholdValue).toBe('+25%')
  })

  it('a falling (-50%) trend trigger shows a negative observed value and a NEGATIVE signed threshold matching the real control-flow boundary', async () => {
    const admin = setupBaseline({ growth: { ...ZERO_GROWTH, newOrders: { current: 25, previous: 50 } } })
    const result = await getIntelligenceInsights(admin)
    const insight = result.insights.find((i) => i.category === 'growth' && /New orders/i.test(i.title))
    expect(insight?.trigger?.operator).toBe('<=')
    expect(insight?.trigger?.observedValue).toBe('-50%')
    expect(insight?.trigger?.thresholdValue).toBe('-25%')
  })
})

describe('getIntelligenceInsights: E2-F1 rule registry threshold completeness (category: ADMIN-CONTROL-CENTRE-BATCH-E2-F1)', () => {
  it('SUPPLY_CATEGORY_CONCENTRATION references the real minimum-listing floor it is actually gated by', () => {
    expect(RULE_REGISTRY.SUPPLY_CATEGORY_CONCENTRATION.thresholdRefs).toContain('MIN_REAL_LISTINGS_FOR_SUPPLY_SIGNAL')
    expect(RULE_REGISTRY.SUPPLY_CATEGORY_CONCENTRATION.thresholdRefs).toContain('CATEGORY_CONCENTRATION_SHARE')
  })

  it('every GROWTH_* registry entry references the sample-floor threshold it actually uses for confidence/sufficiency', () => {
    const growthRuleIds = Object.keys(RULE_REGISTRY).filter((id) => id.startsWith('GROWTH_'))
    expect(growthRuleIds.length).toBe(10)
    for (const id of growthRuleIds) {
      expect(RULE_REGISTRY[id as keyof typeof RULE_REGISTRY].thresholdRefs).toContain('MIN_REAL_PROFILES_FOR_TREND')
      expect(RULE_REGISTRY[id as keyof typeof RULE_REGISTRY].thresholdRefs).toContain('GROWTH_SWING_PCT')
    }
  })

  it('TRUST_KYC_STATUS_MIX references its sample-floor threshold', () => {
    expect(RULE_REGISTRY.TRUST_KYC_STATUS_MIX.thresholdRefs).toContain('MIN_REAL_PROFILES_FOR_TREND')
  })

  it('TRUST_REVIEWS_SPARSE references the new named sparse-review-rate constant, not a bare magic number', () => {
    expect(RULE_REGISTRY.TRUST_REVIEWS_SPARSE.thresholdRefs).toContain('MAX_REVIEW_RATE_FOR_SPARSE_SIGNAL')
  })

  it('no thresholdRefs entry anywhere in RULE_REGISTRY names a nonexistent THRESHOLDS key', () => {
    for (const meta of Object.values(RULE_REGISTRY)) {
      for (const ref of meta.thresholdRefs ?? []) {
        expect(THRESHOLDS_KEYS).toContain(ref)
      }
    }
  })

  it('every RuleId has exactly one RULE_REGISTRY entry with a valid evidenceBasis', () => {
    for (const meta of Object.values(RULE_REGISTRY)) {
      expect(['period', 'snapshot', 'structural']).toContain(meta.evidenceBasis)
    }
  })
})

describe('getIntelligenceInsights: E2-F1 degraded-source trigger truthfulness (category: ADMIN-CONTROL-CENTRE-BATCH-E2-F1)', () => {
  it('1 failed source: fires at medium priority, and the trigger reflects the actual firing floor (1), not the high-escalation floor', async () => {
    const admin = setupBaseline()
    getMarketplaceOverview.mockRejectedValue(new Error('x'))
    const result = await getIntelligenceInsights(admin)
    const degraded = result.insights.find((i) => /partially unavailable/i.test(i.title))
    expect(degraded?.priority).toBe('medium')
    expect(degraded?.trigger?.observedValue).toBe(1)
    expect(degraded?.trigger?.thresholdValue).toBe(1)
    expect(degraded?.limitations.some((l) => /escalates to high priority/i.test(l))).toBe(true)
  })

  it('3+ failed sources: escalates to high priority, and the escalation floor is truthfully disclosed', async () => {
    const admin = setupBaseline()
    getMarketplaceOverview.mockRejectedValue(new Error('x'))
    getSupplyAnalytics.mockRejectedValue(new Error('x'))
    getDemandAnalytics.mockRejectedValue(new Error('x'))
    const result = await getIntelligenceInsights(admin)
    const degraded = result.insights.find((i) => /partially unavailable/i.test(i.title))
    expect(degraded?.priority).toBe('high')
    expect(degraded?.trigger?.observedValue).toBe(3)
    expect(degraded?.limitations.some((l) => /escalates to high priority once 3/i.test(l))).toBe(true)
  })
})

describe('getIntelligenceInsights: E2 privacy -- trigger/limitations carry no PII (category: ADMIN-CONTROL-CENTRE-BATCH-E2)', () => {
  it('F1. trigger and limitations fields contain no email, phone, or raw UUID shape', async () => {
    const admin = setupBaseline({
      growth: { ...ZERO_GROWTH, newUsers: { current: 20, previous: 10 } },
      trust: { ...ZERO_TRUST, accountRestrictions: { restricted: 3, suspended: 3 } },
      overviewStats: { pending_kyc_reviews: 40, pending_ownership_reviews: 0, pending_listing_moderation: 0, failed_financial_workflows: 0, retryable_email_failures: 0 },
    })
    const result = await getIntelligenceInsights(admin)
    const blob = JSON.stringify(result.insights.map((i) => ({ trigger: i.trigger, limitations: i.limitations })))
    expect(blob).not.toMatch(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i)
    expect(blob).not.toMatch(/\+?\d{9,}/)
    expect(blob).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
  })
})

describe('getIntelligenceInsights: E2 failure isolation regression (category: ADMIN-CONTROL-CENTRE-BATCH-E2)', () => {
  it('G1. a source rejection still resolves a valid IntelligenceResult including sourceHealth', async () => {
    const admin = setupBaseline()
    getSupportAnalytics.mockRejectedValue(new Error('x'))
    const result = await getIntelligenceInsights(admin)
    expect(result.summary).toBeDefined()
    expect(result.sourceHealth.find((s) => s.source === 'support')?.status).toBe('degraded')
  })
})

describe('getIntelligenceInsights: E2 homepage scope after model extension (category: ADMIN-CONTROL-CENTRE-BATCH-E2)', () => {
  it('H1. Real Data and Operational high-priority counts remain separated after the E2 model extension', async () => {
    const admin = setupBaseline({
      growth: { ...ZERO_GROWTH, newUsers: { current: 100, previous: 50 } },
      overviewStats: { pending_kyc_reviews: 0, pending_ownership_reviews: 0, pending_listing_moderation: 40, failed_financial_workflows: 0, retryable_email_failures: 0 },
    })
    const result = await getIntelligenceInsights(admin)
    expect(result.summary.realData.highPriority).toBe(1)
    expect(result.summary.operational.highPriority).toBe(1)
  })

  it('H2. a degraded-source count derived from sourceHealth matches the number of degraded rows', async () => {
    const admin = setupBaseline()
    getSupplyAnalytics.mockRejectedValue(new Error('x'))
    getDemandAnalytics.mockRejectedValue(new Error('x'))
    const result = await getIntelligenceInsights(admin)
    const degradedSourceCount = result.sourceHealth.filter((s) => s.status === 'degraded').length
    expect(degradedSourceCount).toBe(2)
  })
})

describe('getIntelligenceInsights: E3 insight fingerprint (category: ADMIN-CONTROL-CENTRE-BATCH-E3)', () => {
  it('1. identical insight evidence produces an identical fingerprint across repeated calls', async () => {
    const admin1 = setupBaseline({ growth: { ...ZERO_GROWTH, newUsers: { current: 20, previous: 10 } } })
    const result1 = await getIntelligenceInsights(admin1)
    const admin2 = setupBaseline({ growth: { ...ZERO_GROWTH, newUsers: { current: 20, previous: 10 } } })
    const result2 = await getIntelligenceInsights(admin2)
    const fp1 = result1.insights.find((i) => i.ruleId === RULE_IDS.GROWTH_NEW_USERS_UP)?.fingerprint
    const fp2 = result2.insights.find((i) => i.ruleId === RULE_IDS.GROWTH_NEW_USERS_UP)?.fingerprint
    expect(fp1).toBeDefined()
    expect(fp1).toBe(fp2)
  })

  it('2. different material evidence (a different observed count) produces a different fingerprint', async () => {
    const admin1 = setupBaseline({ growth: { ...ZERO_GROWTH, newUsers: { current: 20, previous: 10 } } })
    const result1 = await getIntelligenceInsights(admin1)
    const admin2 = setupBaseline({ growth: { ...ZERO_GROWTH, newUsers: { current: 100, previous: 50 } } })
    const result2 = await getIntelligenceInsights(admin2)
    const fp1 = result1.insights.find((i) => i.ruleId === RULE_IDS.GROWTH_NEW_USERS_UP)?.fingerprint
    const fp2 = result2.insights.find((i) => i.ruleId === RULE_IDS.GROWTH_NEW_USERS_UP)?.fingerprint
    expect(fp1).not.toBe(fp2)
  })

  it('3. a generatedAt change alone (same evidence, different moment) does NOT change the fingerprint', async () => {
    const admin1 = setupBaseline({ growth: { ...ZERO_GROWTH, newUsers: { current: 20, previous: 10 } } })
    const result1 = await getIntelligenceInsights(admin1)
    await new Promise((r) => setTimeout(r, 5))
    const admin2 = setupBaseline({ growth: { ...ZERO_GROWTH, newUsers: { current: 20, previous: 10 } } })
    const result2 = await getIntelligenceInsights(admin2)
    const insight1 = result1.insights.find((i) => i.ruleId === RULE_IDS.GROWTH_NEW_USERS_UP)
    const insight2 = result2.insights.find((i) => i.ruleId === RULE_IDS.GROWTH_NEW_USERS_UP)
    expect(insight1?.generatedAt).not.toBe(insight2?.generatedAt)
    expect(insight1?.fingerprint).toBe(insight2?.fingerprint)
  })

  it('4. two different rule families never collide even with superficially similar evidence shapes', async () => {
    const admin = setupBaseline({
      growth: { ...ZERO_GROWTH, newUsers: { current: 20, previous: 10 } },
      overviewStats: { pending_kyc_reviews: 40, pending_ownership_reviews: 0, pending_listing_moderation: 0, failed_financial_workflows: 0, retryable_email_failures: 0 },
    })
    const result = await getIntelligenceInsights(admin)
    const fingerprints = result.insights.map((i) => i.fingerprint)
    expect(new Set(fingerprints).size).toBe(fingerprints.length)
  })

  it('5. no PII-shaped content enters the fingerprint input -- the fingerprint is always a 64-char lowercase hex SHA-256 digest, never a free-text echo', async () => {
    const admin = setupBaseline({ growth: { ...ZERO_GROWTH, newUsers: { current: 20, previous: 10 } } })
    const result = await getIntelligenceInsights(admin)
    for (const insight of result.insights) {
      expect(insight.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('6. FINGERPRINT_VERSION is a stable integer and is attached to every insight as fingerprintVersion', async () => {
    expect(Number.isInteger(FINGERPRINT_VERSION)).toBe(true)
    const admin = setupBaseline({ growth: { ...ZERO_GROWTH, newUsers: { current: 20, previous: 10 } } })
    const result = await getIntelligenceInsights(admin)
    for (const insight of result.insights) {
      expect(insight.fingerprintVersion).toBe(FINGERPRINT_VERSION)
    }
  })

  it('7. evaluation metadata (which does not exist on the generation path at all) cannot affect the fingerprint -- getIntelligenceInsights never accepts or reads any evaluation input', async () => {
    expect(getIntelligenceInsights.length).toBe(1) // only (admin) -- no evaluation/feedback parameter exists to pass
  })
})

describe('getIntelligenceInsights: E3 no behavioral feedback loop -- evaluation never influences generation (category: ADMIN-CONTROL-CENTRE-BATCH-E3)', () => {
  it('given identical analytics inputs, the full generated result (insights, priorities, confidence, sufficiency, order, source health, summary) is identical across repeated calls -- there is no hidden state an evaluation could have written to', async () => {
    const baseline = {
      growth: { ...ZERO_GROWTH, newUsers: { current: 20, previous: 10 } },
      overviewStats: { pending_kyc_reviews: 40, pending_ownership_reviews: 0, pending_listing_moderation: 0, failed_financial_workflows: 0, retryable_email_failures: 0 },
      trust: { ...ZERO_TRUST, accountRestrictions: { restricted: 3, suspended: 3 } },
    }
    const admin1 = setupBaseline(baseline)
    const result1 = await getIntelligenceInsights(admin1)
    const admin2 = setupBaseline(baseline)
    const result2 = await getIntelligenceInsights(admin2)

    const strip = (r: typeof result1) => ({
      summary: r.summary,
      sourceHealth: r.sourceHealth,
      insights: r.insights.map((i) => ({
        ruleId: i.ruleId, category: i.category, type: i.type, priority: i.priority,
        confidence: i.confidence, dataSufficiency: i.dataSufficiency, scope: i.scope,
        fingerprint: i.fingerprint, evidence: i.evidence, trigger: i.trigger,
      })),
    })
    expect(strip(result1)).toEqual(strip(result2))
  })

  it('getIntelligenceInsights has no evaluation/feedback parameter in its signature -- structurally cannot read evaluation state even if some existed', () => {
    expect(getIntelligenceInsights.length).toBe(1)
  })
})
