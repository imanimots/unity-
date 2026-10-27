import { describe, it, expect } from 'vitest'
import { randomUUID } from 'crypto'
import {
  analyticsIngestRequestSchema,
  validateEventMetadata,
  sanitizeRoutePath,
  isExcludedFromPageViews,
  MAX_INGEST_BODY_BYTES,
  EVENT_METADATA_SCHEMAS,
} from '../validation'
import { ANALYTICS_EVENT_NAMES } from '../events'

describe('analyticsIngestRequestSchema (category: ADMIN-CONTROL-CENTRE-BATCH-D2)', () => {
  it('1. accepts a minimal valid page_view event', () => {
    const parsed = analyticsIngestRequestSchema.safeParse({ eventId: randomUUID(), eventName: 'page_view' })
    expect(parsed.success).toBe(true)
  })

  it('2. rejects an event name not on the allowlist', () => {
    const parsed = analyticsIngestRequestSchema.safeParse({ eventId: randomUUID(), eventName: 'payment_completed' })
    expect(parsed.success).toBe(false)
  })

  it('3. rejects a missing/invalid eventId', () => {
    expect(analyticsIngestRequestSchema.safeParse({ eventName: 'page_view' }).success).toBe(false)
    expect(analyticsIngestRequestSchema.safeParse({ eventId: 'not-a-uuid', eventName: 'page_view' }).success).toBe(false)
  })

  it('4. the schema has no field for actor_state, data_classification, or occurred_at -- a client cannot set privileged/server-derived fields even if present in the raw body', () => {
    const parsed = analyticsIngestRequestSchema.safeParse({
      eventId: randomUUID(),
      eventName: 'page_view',
      actorState: 'admin',
      dataClassification: 'real',
      occurredAt: '2020-01-01T00:00:00Z',
    })
    expect(parsed.success).toBe(true)
    // Zod strips unrecognized keys by default -- none of the spoofed fields survive parsing.
    expect(parsed.success && 'actorState' in parsed.data).toBe(false)
    expect(parsed.success && 'dataClassification' in parsed.data).toBe(false)
    expect(parsed.success && 'occurredAt' in parsed.data).toBe(false)
  })

  it('5. rejects an entityType outside listing/booking/order', () => {
    const parsed = analyticsIngestRequestSchema.safeParse({ eventId: randomUUID(), eventName: 'page_view', entityType: 'profile' })
    expect(parsed.success).toBe(false)
  })

  it('6. metadata keys are bounded to 50 characters and values to the safe union type', () => {
    const tooLongKey = 'x'.repeat(51)
    expect(analyticsIngestRequestSchema.safeParse({ eventId: randomUUID(), eventName: 'page_view', metadata: { [tooLongKey]: 'v' } }).success).toBe(false)
    expect(analyticsIngestRequestSchema.safeParse({ eventId: randomUUID(), eventName: 'page_view', metadata: { k: { nested: true } } }).success).toBe(false)
  })
})

describe('validateEventMetadata -- per-event allowlist (category: ADMIN-CONTROL-CENTRE-BATCH-D2)', () => {
  it('1. every event name in ANALYTICS_EVENT_NAMES has a defined metadata schema (search_refined\'s filter_count is required, so {} alone is a valid rejection, not a missing schema)', () => {
    for (const name of ANALYTICS_EVENT_NAMES) {
      expect(EVENT_METADATA_SCHEMAS[name], `expected ${name} to have a schema`).toBeDefined()
    }
    // search_refined specifically requires filter_count -- {} is correctly rejected, and the real required shape is correctly accepted.
    expect(validateEventMetadata('search_refined', {}).ok).toBe(false)
    expect(validateEventMetadata('search_refined', { filter_count: 1 }).ok).toBe(true)
  })

  it('2. rejects an unknown metadata field for a strict event (e.g. page_view accepts no fields at all)', () => {
    const result = validateEventMetadata('page_view', { sneaky_field: 'x' })
    expect(result.ok).toBe(false)
  })

  it('3. rejects an unknown metadata field even when some other fields on the same event are legitimate', () => {
    const result = validateEventMetadata('search_started', { has_query: true, raw_query_text: 'laptop for rent' })
    expect(result.ok).toBe(false)
  })

  it('4. accepts the documented safe fields for search_started', () => {
    const result = validateEventMetadata('search_started', { has_query: true, category: 'electronics', filter_count: 2 })
    expect(result.ok).toBe(true)
  })

  it('5. rejects an oversized metadata string field', () => {
    const result = validateEventMetadata('search_started', { category: 'x'.repeat(300) })
    expect(result.ok).toBe(false)
  })

  it('6. rejects an event name with no corresponding schema (defensive -- should never happen given the allowlist, but must not throw)', () => {
    // @ts-expect-error -- deliberately an invalid event name to prove the function degrades safely
    const result = validateEventMetadata('not_a_real_event', {})
    expect(result.ok).toBe(false)
  })

  it('7. never includes a raw free-text search query field on any event -- confirms Section 5\'s prohibition is enforced by the schemas themselves, not just convention', () => {
    for (const name of ANALYTICS_EVENT_NAMES) {
      const result = validateEventMetadata(name, { q: 'anything', query: 'anything', search_text: 'anything' })
      expect(result.ok, `${name} should reject a raw query-text field`).toBe(false)
    }
  })
})

describe('sanitizeRoutePath (category: ADMIN-CONTROL-CENTRE-BATCH-D2)', () => {
  it('1. strips a query string', () => {
    expect(sanitizeRoutePath('/browse?email=a@b.com&token=secret')).toBe('/browse')
  })

  it('2. strips a hash fragment', () => {
    expect(sanitizeRoutePath('/listing/123#reviews')).toBe('/listing/123')
  })

  it('3. returns null for a non-path value', () => {
    expect(sanitizeRoutePath('not-a-path')).toBeNull()
    expect(sanitizeRoutePath(undefined)).toBeNull()
    expect(sanitizeRoutePath(null)).toBeNull()
    expect(sanitizeRoutePath('')).toBeNull()
  })

  it('4. truncates an overlong path to 200 characters', () => {
    const long = `/${'a'.repeat(500)}`
    expect(sanitizeRoutePath(long)?.length).toBe(200)
  })

  it('5. a plain path with no query/hash passes through unchanged', () => {
    expect(sanitizeRoutePath('/listings')).toBe('/listings')
  })
})

describe('isExcludedFromPageViews (category: ADMIN-CONTROL-CENTRE-BATCH-D2)', () => {
  it('1. excludes /api/* paths', () => {
    expect(isExcludedFromPageViews('/api/bookings')).toBe(true)
  })

  it('2. excludes /admin* paths', () => {
    expect(isExcludedFromPageViews('/admin/analytics')).toBe(true)
  })

  it('3. does not exclude an ordinary consumer page', () => {
    expect(isExcludedFromPageViews('/listings')).toBe(false)
    expect(isExcludedFromPageViews('/')).toBe(false)
  })
})

describe('MAX_INGEST_BODY_BYTES (category: ADMIN-CONTROL-CENTRE-BATCH-D2)', () => {
  it('1. is a small, finite bound -- telemetry stays compact (Section 14)', () => {
    expect(MAX_INGEST_BODY_BYTES).toBeGreaterThan(0)
    expect(MAX_INGEST_BODY_BYTES).toBeLessThanOrEqual(10_000)
  })
})
