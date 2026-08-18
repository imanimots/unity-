import type {
  PersonalizationMode,
  PersonalizationProfileInput,
  PersonalizationViewRecord,
  RecommendationCandidate,
  RecommendationReasonCode,
  ScoredRecommendation,
} from './types'

/**
 * Deterministic scoring engine -- no machine learning, no external calls.
 * Every weight is a named constant documented here (Section 22/23: "keep
 * scoring deterministic and testable... document the actual weights").
 */
export const SCORE_WEIGHTS = {
  /** A view in the recent window contributes this much to that view's category/mode affinity. */
  VIEW_BASE: 3,
  /** Explicit preference match (Settings > Interests). */
  PREFERRED_CATEGORY: 4,
  PREFERRED_MODE: 2,
  PREFERRED_KIND: 2,
  /** A completed transaction is the strongest positive signal (Section 18). */
  COMPLETED_CATEGORY: 5,
  /** Explicit province/city match (never inferred -- Section 12). */
  LOCATION_PROVINCE: 1,
  LOCATION_CITY: 2,
  /** Small freshness nudge for the candidate itself, distinct from behavioral recency. */
  CANDIDATE_RECENCY: 1,
  /** Small penalty applied outside Continue Browsing when a candidate was already viewed (Section 25). */
  ALREADY_VIEWED_PENALTY: -1.5,
} as const

/** Recency decay for BEHAVIORAL signals (Section 23): a view's own weight
 * is multiplied by how recent it was, not a statistical decay curve. */
export function viewRecencyMultiplier(viewedAtIso: string, now: Date = new Date()): number {
  const ageDays = (now.getTime() - new Date(viewedAtIso).getTime()) / (1000 * 60 * 60 * 24)
  if (ageDays <= 7) return 1
  if (ageDays <= 30) return 0.5
  return 0.15
}

/** view_count is already capped at 5 server-side (Section 59); this is a
 * second, defensive cap so a malformed/anonymous-merged record can never
 * exceed it either. */
export function effectiveViewWeight(viewCount: number): number {
  return Math.min(Math.max(viewCount, 1), 5)
}

interface Affinity {
  categories: Map<string, number>
  modes: Map<PersonalizationMode, number>
}

/** Aggregates a profile's VIEW history only into simple per-category/
 * per-mode affinity scores. Pure function -- same input always produces
 * the same output.
 *
 * Deliberately view-only: completed-transaction and explicit-preference
 * signals are scored separately, once each, directly in scoreCandidate()
 * below. They used to also be bumped into this same map, which silently
 * double-counted their weight (once here, once again in scoreCandidate's
 * own dedicated checks) and mislabeled the result as reasonCode
 * 'recently_viewed' even when the user had never actually viewed the
 * candidate -- only completed a transaction or set a preference in that
 * category. Keeping this map view-only makes both the score and the
 * 'recently_viewed' label accurate. */
export function buildAffinity(profile: PersonalizationProfileInput, now: Date = new Date()): Affinity {
  const categories = new Map<string, number>()
  const modes = new Map<PersonalizationMode, number>()

  const bump = (map: Map<string, number>, key: string | null, amount: number) => {
    if (!key) return
    map.set(key, (map.get(key) ?? 0) + amount)
  }

  for (const view of profile.views) {
    const weight = SCORE_WEIGHTS.VIEW_BASE * effectiveViewWeight(view.viewCount) * viewRecencyMultiplier(view.lastViewedAt, now)
    bump(categories, view.category, weight)
    if (view.mode) bump(modes as unknown as Map<string, number>, view.mode, weight)
  }

  return { categories, modes }
}

function wasRecentlyViewed(candidate: RecommendationCandidate, views: PersonalizationViewRecord[]): boolean {
  return views.some((v) => v.entityType === candidate.entityType && v.entityId === candidate.entityId)
}

/** Scores one candidate against a profile. Pure, deterministic. */
export function scoreCandidate(
  candidate: RecommendationCandidate,
  profile: PersonalizationProfileInput,
  affinity: Affinity,
  options: { module: 'continue_browsing' | 'recommended_for_you' | 'because_you_viewed' | 'near_your_area'; viewerId: string | null; now?: Date }
): ScoredRecommendation | null {
  const now = options.now ?? new Date()

  // Section 26: never recommend the viewer's own content in a consumer module.
  if (options.viewerId && candidate.merchantId && candidate.merchantId === options.viewerId) return null

  let score = 0
  const reasonCodes: RecommendationReasonCode[] = []
  const reasonContext: ScoredRecommendation['reasonContext'] = {}

  if (candidate.category && affinity.categories.has(candidate.category)) {
    score += affinity.categories.get(candidate.category)!
    reasonCodes.push('recently_viewed')
    reasonContext.category = candidate.category
  }
  if (candidate.mode && affinity.modes.has(candidate.mode)) {
    score += affinity.modes.get(candidate.mode)!
    reasonContext.mode = candidate.mode
  }

  if (profile.settings) {
    if (candidate.category && profile.settings.preferredCategories.includes(candidate.category)) {
      score += SCORE_WEIGHTS.PREFERRED_CATEGORY
      if (!reasonCodes.includes('preferred_category')) reasonCodes.push('preferred_category')
      reasonContext.category = candidate.category
    }
    if (candidate.mode && profile.settings.preferredModes.includes(candidate.mode)) {
      score += SCORE_WEIGHTS.PREFERRED_MODE
      reasonCodes.push('preferred_mode')
      reasonContext.mode = candidate.mode
    }
    if (candidate.kind && profile.settings.preferredBarterKinds.includes(candidate.kind)) {
      score += SCORE_WEIGHTS.PREFERRED_KIND
      reasonCodes.push('preferred_kind')
    }
    if (profile.settings.preferredCity && candidate.city && candidate.city === profile.settings.preferredCity) {
      score += SCORE_WEIGHTS.LOCATION_CITY
      reasonCodes.push('location_match')
      reasonContext.city = candidate.city
    } else if (profile.settings.preferredProvince && candidate.province && candidate.province === profile.settings.preferredProvince) {
      score += SCORE_WEIGHTS.LOCATION_PROVINCE
      reasonCodes.push('location_match')
    }
  }

  if (candidate.category && profile.completedCategories.includes(candidate.category)) {
    score += SCORE_WEIGHTS.COMPLETED_CATEGORY
    reasonCodes.push('completed_similar')
    reasonContext.category = candidate.category
  }
  if (candidate.mode && profile.completedModes.includes(candidate.mode)) {
    score += SCORE_WEIGHTS.COMPLETED_CATEGORY
    if (!reasonCodes.includes('completed_similar')) reasonCodes.push('completed_similar')
    reasonContext.mode = candidate.mode
  }

  const candidateAgeDays = (now.getTime() - new Date(candidate.createdAt).getTime()) / (1000 * 60 * 60 * 24)
  if (candidateAgeDays <= 14) score += SCORE_WEIGHTS.CANDIDATE_RECENCY

  const previouslyViewed = wasRecentlyViewed(candidate, profile.views)
  if (options.module !== 'continue_browsing' && previouslyViewed) {
    score += SCORE_WEIGHTS.ALREADY_VIEWED_PENALTY
  }

  // Cold start (Section 55): a candidate with literally zero contributing
  // signal must never be labeled "Recommended for you" -- the caller
  // (recommendations service) falls back to a generic module instead when
  // every candidate scores at or below zero; this function just reports
  // the true score honestly.
  if (reasonCodes.length === 0 && score <= 0) {
    reasonCodes.push('newest')
  }

  return { entityType: candidate.entityType, entityId: candidate.entityId, score, reasonCodes, reasonContext }
}

export interface DiversifyOptions {
  /** entityId -> merchantId, for the repetition cap. */
  merchantByEntity: Map<string, string | null>
  maxPerMerchant: number
  maxShareForOneCategory: number
  /** entityId -> category, for the category-dominance cap. */
  categoryByEntity: Map<string, string | null>
  limit: number
}

/** Simple diversification pass (Section 24): does not re-score, only
 * re-orders/trims a set that's already sorted by score descending. */
export function diversify(sorted: ScoredRecommendation[], options: DiversifyOptions): ScoredRecommendation[] {
  const result: ScoredRecommendation[] = []
  const merchantCounts = new Map<string, number>()
  const categoryCounts = new Map<string, number>()
  const maxOfOneCategory = Math.max(1, Math.floor(options.limit * options.maxShareForOneCategory))

  for (const item of sorted) {
    if (result.length >= options.limit) break
    const merchantId = options.merchantByEntity.get(item.entityId) ?? null
    const category = options.categoryByEntity.get(item.entityId) ?? null

    if (merchantId) {
      const count = merchantCounts.get(merchantId) ?? 0
      if (count >= options.maxPerMerchant) continue
    }
    if (category) {
      const count = categoryCounts.get(category) ?? 0
      if (count >= maxOfOneCategory && result.length > 0) continue
    }

    result.push(item)
    if (merchantId) merchantCounts.set(merchantId, (merchantCounts.get(merchantId) ?? 0) + 1)
    if (category) categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1)
  }

  // Sparse inventory (Section 56): if diversification left the module
  // short, backfill with the next-best candidates rather than force a
  // full/empty module. Diversity caps (merchant repetition, category
  // dominance) are soft PRESENTATION preferences, not eligibility --
  // Section 56 only forbids weakening HARD public eligibility (test/
  // inactive/private content) here, so backfill deliberately relaxes
  // the diversity caps rather than under-filling a module when the
  // available inventory is simply concentrated in one merchant/category
  // (e.g. only one active merchant in a niche category) -- showing 2
  // relevant items from the same merchant beats showing 1.
  if (result.length < options.limit) {
    for (const item of sorted) {
      if (result.length >= options.limit) break
      if (!result.some((r) => r.entityId === item.entityId)) result.push(item)
    }
  }

  return result
}

/** Orchestrates score + sort + diversify for one module. Candidates must
 * already be public-eligible (Section 27) -- this function does not
 * re-check eligibility, it only ranks. */
export function rankCandidates(
  candidates: RecommendationCandidate[],
  profile: PersonalizationProfileInput,
  options: { module: 'continue_browsing' | 'recommended_for_you' | 'because_you_viewed' | 'near_your_area'; viewerId: string | null; limit: number; now?: Date }
): ScoredRecommendation[] {
  const now = options.now ?? new Date()
  const affinity = buildAffinity(profile, now)

  const scored = candidates
    .map((c) => scoreCandidate(c, profile, affinity, { module: options.module, viewerId: options.viewerId, now }))
    .filter((s): s is ScoredRecommendation => s !== null)
    .sort((a, b) => b.score - a.score)

  const merchantByEntity = new Map(candidates.map((c) => [c.entityId, c.merchantId]))
  const categoryByEntity = new Map(candidates.map((c) => [c.entityId, c.category]))

  return diversify(scored, {
    merchantByEntity,
    categoryByEntity,
    maxPerMerchant: 2,
    maxShareForOneCategory: 0.6,
    limit: options.limit,
  })
}

/** Section 34: Continue Browsing ranks primarily by recency, not affinity score. */
export function rankContinueBrowsing(views: PersonalizationViewRecord[], eligibleEntityIds: Set<string>, limit: number): PersonalizationViewRecord[] {
  return [...views]
    .filter((v) => eligibleEntityIds.has(v.entityId))
    .sort((a, b) => new Date(b.lastViewedAt).getTime() - new Date(a.lastViewedAt).getTime())
    .slice(0, limit)
}
