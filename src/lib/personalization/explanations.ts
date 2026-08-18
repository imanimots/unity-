import type { RecommendationReasonCode, ScoredRecommendation } from './types'

/**
 * Maps a stable reason code (Section 47) to the i18n message key that
 * renders it. No localized prose is ever stored in the database --
 * only the code + minimal context (category/mode/city), translated at
 * render time via next-intl. See the `reasons` section of each locale's
 * personalization.json dictionary.
 */
const REASON_MESSAGE_KEYS: Record<RecommendationReasonCode, string> = {
  recently_viewed: 'personalization.reasons.recentlyViewed',
  preferred_category: 'personalization.reasons.preferredCategory',
  preferred_mode: 'personalization.reasons.preferredMode',
  preferred_kind: 'personalization.reasons.preferredKind',
  completed_similar: 'personalization.reasons.completedSimilar',
  location_match: 'personalization.reasons.locationMatch',
  newest: 'personalization.reasons.newest',
}

export function primaryReasonCode(recommendation: Pick<ScoredRecommendation, 'reasonCodes'>): RecommendationReasonCode {
  return recommendation.reasonCodes[0] ?? 'newest'
}

export function reasonMessageKey(code: RecommendationReasonCode): string {
  return REASON_MESSAGE_KEYS[code]
}
