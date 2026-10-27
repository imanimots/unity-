import type { AnalyticsEntityType, AnalyticsEventName } from './events'

/** Derived server-side only (getRequestProfile()'s profile.role) -- never trusted from a client-supplied claim. */
export type AnalyticsActorState = 'anonymous' | 'authenticated' | 'merchant' | 'admin'

/**
 * Three-state, never silently collapsed to "real" (Section 8). 'real'
 * and 'test' require an authoritative server-derived signal (e.g. the
 * related listing's is_test column); everything else is 'unknown'.
 */
export type AnalyticsDataClassification = 'real' | 'test' | 'unknown'

/** The shape the client sends to POST /api/analytics/events. Server-derived fields (actor_state, data_classification, occurred_at) are deliberately absent -- the client cannot set them. */
export interface AnalyticsIngestRequest {
  eventId: string
  eventName: AnalyticsEventName
  sessionId?: string
  routePath?: string
  entityType?: AnalyticsEntityType
  entityId?: string
  metadata?: Record<string, string | number | boolean | null>
}

/** The shape a server route passes to recordAnalyticsEvent(). */
export interface ServerAnalyticsEventInput {
  eventName: AnalyticsEventName
  eventId?: string
  sessionId?: string | null
  actorState?: AnalyticsActorState | null
  routePath?: string | null
  entityType?: AnalyticsEntityType
  entityId?: string
  dataClassification?: AnalyticsDataClassification
  metadata?: Record<string, string | number | boolean | null>
}
