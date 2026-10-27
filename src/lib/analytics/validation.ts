import { z } from 'zod'
import { ANALYTICS_ENTITY_TYPES, ANALYTICS_EVENT_NAMES, type AnalyticsEventName } from './events'

/** Hard cap on the serialized request body -- defense in depth alongside the per-field bounds below (Section 14: "reject oversized/unbounded JSON"). */
export const MAX_INGEST_BODY_BYTES = 4_000

const metadataValueSchema = z.union([z.string().max(200), z.number().finite(), z.boolean(), z.null()])

/**
 * Per-event metadata schema, each `.strict()` so an unknown metadata
 * field is rejected rather than silently stored (Section 3: "Unknown
 * metadata fields should be rejected"). Deliberately no field here can
 * ever hold PII, a raw search query, or a timestamp -- see the brief's
 * Section 4/5 prohibitions.
 */
export const EVENT_METADATA_SCHEMAS: Record<AnalyticsEventName, z.ZodType> = {
  page_view: z.object({}).strict(),
  signup_started: z.object({ role: z.enum(['renter', 'merchant', 'both']).optional() }).strict(),
  signup_completed: z.object({ role: z.enum(['renter', 'merchant', 'both']).optional() }).strict(),
  search_started: z.object({
    has_query: z.boolean().optional(),
    category: z.string().max(50).optional(),
    filter_count: z.number().int().min(0).max(20).optional(),
  }).strict(),
  search_results_viewed: z.object({
    result_count: z.number().int().min(0).optional(),
    has_query: z.boolean().optional(),
    category: z.string().max(50).optional(),
  }).strict(),
  search_zero_results: z.object({
    has_query: z.boolean().optional(),
    category: z.string().max(50).optional(),
  }).strict(),
  search_refined: z.object({ filter_count: z.number().int().min(0).max(20) }).strict(),
  listing_viewed: z.object({ category: z.string().max(50).optional() }).strict(),
  listing_creation_started: z.object({}).strict(),
  listing_published: z.object({ category: z.string().max(50).optional() }).strict(),
  rental_checkout_started: z.object({}).strict(),
  booking_created: z.object({}).strict(),
  order_checkout_started: z.object({}).strict(),
  order_created: z.object({}).strict(),
  kyc_started: z.object({}).strict(),
  kyc_submitted: z.object({}).strict(),
}

/** The top-level request shape the ingestion route accepts. Deliberately has no actorState/dataClassification/occurredAt field -- those are always server-derived, never read from the client even if present in the raw JSON body. */
export const analyticsIngestRequestSchema = z.object({
  eventId: z.string().uuid(),
  eventName: z.enum(ANALYTICS_EVENT_NAMES),
  sessionId: z.string().uuid().optional(),
  routePath: z.string().max(200).optional(),
  entityType: z.enum(ANALYTICS_ENTITY_TYPES).optional(),
  entityId: z.string().uuid().optional(),
  metadata: z.record(z.string().max(50), metadataValueSchema).optional(),
})

export type ParsedAnalyticsIngestRequest = z.infer<typeof analyticsIngestRequestSchema>

/** Strips query string/hash and bounds length -- never stores `?email=...`/`?token=...`/free-text search params (Section 4). Returns null for anything that doesn't look like a plain app-internal path. */
export function sanitizeRoutePath(rawPath: string | undefined | null): string | null {
  if (!rawPath) return null
  const withoutQueryOrHash = rawPath.split('?')[0]?.split('#')[0] ?? ''
  if (!withoutQueryOrHash.startsWith('/')) return null
  if (withoutQueryOrHash.length > 200) return withoutQueryOrHash.slice(0, 200)
  return withoutQueryOrHash
}

/** True for paths that must never be counted as a consumer page view (Section 18). */
export function isExcludedFromPageViews(path: string): boolean {
  return path.startsWith('/api/') || path.startsWith('/admin') || path === '/api' || path === '/admin'
}

export interface MetadataValidationResult {
  ok: true
  data: Record<string, string | number | boolean | null>
}
export interface MetadataValidationFailure {
  ok: false
}

/** Validates (and, on success, returns) metadata for a specific event name -- unknown fields or an unsupported event name are rejected, never silently stored. */
export function validateEventMetadata(eventName: AnalyticsEventName, metadata: unknown): MetadataValidationResult | MetadataValidationFailure {
  const schema = EVENT_METADATA_SCHEMAS[eventName]
  if (!schema) return { ok: false }
  const parsed = schema.safeParse(metadata ?? {})
  if (!parsed.success) return { ok: false }
  return { ok: true, data: parsed.data as Record<string, string | number | boolean | null> }
}
