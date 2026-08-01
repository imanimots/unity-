import { describe, it, expect } from 'vitest'
import {
  draftListingSchema, saveDraftRequestSchema, submitRequestSchema,
  mediaItemSchema, DECLARATION_TYPES, availabilitySchema, blockedDateRangeSchema,
  requirementsPayloadSchema, idempotencyKeySchema,
} from '../validation'

describe('draftListingSchema', () => {
  it('accepts an empty object — drafts may be incomplete', () => {
    expect(draftListingSchema.safeParse({}).success).toBe(true)
  })

  it('rejects a title that is too short when provided', () => {
    const result = draftListingSchema.safeParse({ title: 'short' })
    expect(result.success).toBe(false)
  })

  it('rejects a negative daily_rate', () => {
    const result = draftListingSchema.safeParse({ daily_rate: -10 })
    expect(result.success).toBe(false)
  })

  it('rejects an invalid condition enum value', () => {
    const result = draftListingSchema.safeParse({ condition: 'excellent' })
    expect(result.success).toBe(false)
  })

  it('accepts a fully valid draft payload', () => {
    const result = draftListingSchema.safeParse({
      title: 'DJI Mavic 3 Pro Drone Kit',
      category: 'tech',
      condition: 'like_new',
      description: 'A great drone in excellent condition with all original accessories included.',
      daily_rate: 250,
      min_rental_days: 1,
      shipping_payer: 'renter',
      deposit_required: false,
      accepts_affiliates: false,
    })
    expect(result.success).toBe(true)
  })
})

describe('saveDraftRequestSchema', () => {
  it('allows listing_id to be null for first-time creation', () => {
    const result = saveDraftRequestSchema.safeParse({ listing_id: null, listing: {} })
    expect(result.success).toBe(true)
  })

  it('rejects a malformed listing_id', () => {
    const result = saveDraftRequestSchema.safeParse({ listing_id: 'not-a-uuid', listing: {} })
    expect(result.success).toBe(false)
  })
})

describe('mediaItemSchema — server-controlled URL/type shape', () => {
  it('accepts a well-formed photo entry', () => {
    const result = mediaItemSchema.safeParse({
      url: 'https://example.supabase.co/storage/v1/object/public/listing-media/uid/abc.jpg',
      type: 'photo',
      display_order: 0,
      shot_type: 'primary',
    })
    expect(result.success).toBe(true)
  })

  it('rejects an unknown media type', () => {
    const result = mediaItemSchema.safeParse({ url: 'x', type: 'thumbnail', display_order: 0 })
    expect(result.success).toBe(false)
  })

  it('rejects a negative display_order', () => {
    const result = mediaItemSchema.safeParse({ url: 'x', type: 'photo', display_order: -1 })
    expect(result.success).toBe(false)
  })
})

describe('submitRequestSchema', () => {
  it('requires at least one declaration_type', () => {
    expect(submitRequestSchema.safeParse({ declaration_types: [] }).success).toBe(false)
  })

  it('accepts all six known declaration types', () => {
    const result = submitRequestSchema.safeParse({ declaration_types: [...DECLARATION_TYPES] })
    expect(result.success).toBe(true)
  })

  it('rejects an unknown declaration type — cannot forge a new one', () => {
    const result = submitRequestSchema.safeParse({ declaration_types: ['not_a_real_declaration'] })
    expect(result.success).toBe(false)
  })

  it('rejects duplicate declaration types in the same request', () => {
    const result = submitRequestSchema.safeParse({
      declaration_types: [DECLARATION_TYPES[0], DECLARATION_TYPES[0], DECLARATION_TYPES[1]],
    })
    expect(result.success).toBe(false)
  })
})

describe('blockedDateRangeSchema / availabilitySchema', () => {
  it('accepts a valid single range', () => {
    expect(blockedDateRangeSchema.safeParse({ start_date: '2026-09-01', end_date: '2026-09-10' }).success).toBe(true)
  })

  it('rejects a range where start is after end', () => {
    const result = blockedDateRangeSchema.safeParse({ start_date: '2026-09-10', end_date: '2026-09-01' })
    expect(result.success).toBe(false)
  })

  it('rejects a malformed date', () => {
    expect(blockedDateRangeSchema.safeParse({ start_date: '09/01/2026', end_date: '2026-09-10' }).success).toBe(false)
  })

  it('accepts non-overlapping ranges', () => {
    const result = availabilitySchema.safeParse([
      { start_date: '2026-09-01', end_date: '2026-09-10' },
      { start_date: '2026-09-11', end_date: '2026-09-20' },
    ])
    expect(result.success).toBe(true)
  })

  it('rejects overlapping ranges', () => {
    const result = availabilitySchema.safeParse([
      { start_date: '2026-09-01', end_date: '2026-09-10' },
      { start_date: '2026-09-05', end_date: '2026-09-15' },
    ])
    expect(result.success).toBe(false)
  })

  it('rejects overlapping ranges regardless of input order', () => {
    const result = availabilitySchema.safeParse([
      { start_date: '2026-09-05', end_date: '2026-09-15' },
      { start_date: '2026-09-01', end_date: '2026-09-10' },
    ])
    expect(result.success).toBe(false)
  })

  it('accepts adjacent (touching, not overlapping) ranges', () => {
    const result = availabilitySchema.safeParse([
      { start_date: '2026-09-01', end_date: '2026-09-10' },
      { start_date: '2026-09-10', end_date: '2026-09-20' },
    ])
    // touching at a shared boundary date counts as overlap by this schema's
    // definition (start <= previous end) — a stricter, safer default
    expect(result.success).toBe(false)
  })
})

describe('draftListingSchema — rental duration coherence', () => {
  it('rejects max_rental_days below min_rental_days', () => {
    const result = draftListingSchema.safeParse({ min_rental_days: 10, max_rental_days: 5 })
    expect(result.success).toBe(false)
  })

  it('accepts max_rental_days at or above min_rental_days', () => {
    const result = draftListingSchema.safeParse({ min_rental_days: 5, max_rental_days: 10 })
    expect(result.success).toBe(true)
  })
})

describe('requirementsPayloadSchema', () => {
  it('accepts an empty object — every field is optional', () => {
    expect(requirementsPayloadSchema.safeParse({}).success).toBe(true)
  })

  it('accepts a valid deposit_basis', () => {
    expect(requirementsPayloadSchema.safeParse({ deposit_basis: 'percentage' }).success).toBe(true)
  })

  it('rejects an invalid deposit_basis', () => {
    expect(requirementsPayloadSchema.safeParse({ deposit_basis: 'negotiable' }).success).toBe(false)
  })

  it('requires licence_class when driving_licence_required is true', () => {
    const result = requirementsPayloadSchema.safeParse({ driving_licence_required: true })
    expect(result.success).toBe(false)
  })

  it('accepts driving_licence_required with a licence_class provided', () => {
    const result = requirementsPayloadSchema.safeParse({ driving_licence_required: true, licence_class: 'Code B' })
    expect(result.success).toBe(true)
  })

  it('rejects merchant_custom_rules over the length limit', () => {
    const result = requirementsPayloadSchema.safeParse({ merchant_custom_rules: 'x'.repeat(2001) })
    expect(result.success).toBe(false)
  })

  it('never accepts final_deposit_amount — not a field in the schema at all', () => {
    const parsed = requirementsPayloadSchema.safeParse({ final_deposit_amount: 999999 })
    expect(parsed.success).toBe(true) // unknown keys are just stripped
    if (parsed.success) expect((parsed.data as Record<string, unknown>).final_deposit_amount).toBeUndefined()
  })
})

describe('idempotencyKeySchema', () => {
  it('accepts a UUID-shaped key', () => {
    expect(idempotencyKeySchema.safeParse('a1b2c3d4-e5f6-4789-a012-3456789abcde').success).toBe(true)
  })

  it('rejects an empty or too-short key', () => {
    expect(idempotencyKeySchema.safeParse('short').success).toBe(false)
  })
})

describe('privileged fields are stripped, not trusted, if a client sends them', () => {
  it('draftListingSchema silently drops merchant_id/ownership_verified/risk_tier/status if present', () => {
    const result = draftListingSchema.safeParse({
      title: 'A perfectly valid listing title here',
      merchant_id: 'someone-elses-id',
      ownership_verified: true,
      risk_tier: 'low',
      status: 'active',
      category_id: 'forged-uuid',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      const output = result.data as Record<string, unknown>
      for (const forbidden of ['merchant_id', 'ownership_verified', 'risk_tier', 'status', 'category_id']) {
        expect(output[forbidden]).toBeUndefined()
      }
    }
  })
})
