/** Shared vocabulary for the whole personalization domain. Keep small (Section 17). */

export type PersonalizationMode = 'buy' | 'rent' | 'barter'
export type PersonalizationKind = 'item' | 'skill' | 'task'
export type PersonalizationEntityType = 'listing' | 'marketplace_request' | 'barter_skill_task_post'

/** Stable reason codes (Section 47) -- translated at the UI layer, never stored as prose. */
export type RecommendationReasonCode =
  | 'recently_viewed'
  | 'preferred_category'
  | 'preferred_mode'
  | 'preferred_kind'
  | 'completed_similar'
  | 'location_match'
  | 'newest'

export interface PersonalizationSettings {
  userId: string
  personalizationEnabled: boolean
  preferredModes: PersonalizationMode[]
  preferredCategories: string[]
  preferredBarterKinds: PersonalizationKind[]
  interestedLookingFor: boolean
  interestedRtb: boolean
  preferredProvince: string | null
  preferredCity: string | null
  personalizationResetAt: string | null
}

export const DEFAULT_PERSONALIZATION_SETTINGS: Omit<PersonalizationSettings, 'userId'> = {
  personalizationEnabled: true,
  preferredModes: [],
  preferredCategories: [],
  preferredBarterKinds: [],
  interestedLookingFor: false,
  interestedRtb: false,
  preferredProvince: null,
  preferredCity: null,
  personalizationResetAt: null,
}

/** One aggregate (user, entity) view row -- never one row per page load. */
export interface PersonalizationViewRecord {
  entityType: PersonalizationEntityType
  entityId: string
  mode: PersonalizationMode | null
  category: string | null
  kind: PersonalizationKind | null
  province: string | null
  city: string | null
  viewCount: number
  lastViewedAt: string
}

/** A candidate about to be scored -- deliberately minimal (Section 13: "keep signal data minimal"). */
export interface RecommendationCandidate {
  entityType: PersonalizationEntityType
  entityId: string
  mode: PersonalizationMode | null
  category: string | null
  kind: PersonalizationKind | null
  province: string | null
  city: string | null
  merchantId: string | null
  createdAt: string
}

export interface ScoredRecommendation {
  entityType: PersonalizationEntityType
  entityId: string
  score: number
  reasonCodes: RecommendationReasonCode[]
  reasonContext: { category?: string; mode?: string; city?: string }
}

export type RecommendationModule =
  | 'continue_browsing'
  | 'recommended_for_you'
  | 'because_you_viewed'
  | 'near_your_area'

/** Minimal behavioral input the deterministic scorer consumes -- built either from
 * server-side rows (signed-in) or the local anonymous buffer (anonymous), same shape either way. */
export interface PersonalizationProfileInput {
  views: PersonalizationViewRecord[]
  completedCategories: string[]
  completedModes: PersonalizationMode[]
  settings: Pick<
    PersonalizationSettings,
    'preferredModes' | 'preferredCategories' | 'preferredBarterKinds' | 'preferredProvince' | 'preferredCity'
  > | null
}
