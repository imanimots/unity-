import { describe, it, expect } from 'vitest'
import { createBookingRequestSchema, cancelBookingSchema, bookingActionSchema } from '../validation'

describe('createBookingRequestSchema', () => {
  it('accepts a valid request', () => {
    const result = createBookingRequestSchema.safeParse({
      listing_id: '11111111-1111-4111-8111-111111111111',
      start_at: '2026-08-01T10:00:00Z',
      end_at: '2026-08-02T10:00:00Z',
    })
    expect(result.success).toBe(true)
  })

  it('rejects a non-uuid listing_id', () => {
    expect(createBookingRequestSchema.safeParse({ listing_id: 'not-a-uuid', start_at: '2026-08-01T10:00:00Z', end_at: '2026-08-02T10:00:00Z' }).success).toBe(false)
  })

  it('rejects a malformed date', () => {
    expect(
      createBookingRequestSchema.safeParse({
        listing_id: '11111111-1111-4111-8111-111111111111',
        start_at: '01/08/2026',
        end_at: '2026-08-02T10:00:00Z',
      }).success
    ).toBe(false)
  })

  it('rejects a renter_message over the length limit', () => {
    const result = createBookingRequestSchema.safeParse({
      listing_id: '11111111-1111-4111-8111-111111111111',
      start_at: '2026-08-01T10:00:00Z',
      end_at: '2026-08-02T10:00:00Z',
      renter_message: 'x'.repeat(1001),
    })
    expect(result.success).toBe(false)
  })

  it('silently drops a client-supplied merchant_id or price -- not a field in the schema at all', () => {
    const parsed = createBookingRequestSchema.safeParse({
      listing_id: '11111111-1111-4111-8111-111111111111',
      start_at: '2026-08-01T10:00:00Z',
      end_at: '2026-08-02T10:00:00Z',
      merchant_id: 'someone-elses-id',
      rental_fee: 1,
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      const output = parsed.data as Record<string, unknown>
      expect(output.merchant_id).toBeUndefined()
      expect(output.rental_fee).toBeUndefined()
    }
  })
})

describe('cancelBookingSchema', () => {
  it('accepts an empty object -- reason is optional', () => {
    expect(cancelBookingSchema.safeParse({}).success).toBe(true)
  })

  it('rejects a too-short idempotency key', () => {
    expect(cancelBookingSchema.safeParse({ idempotency_key: 'short' }).success).toBe(false)
  })
})

describe('bookingActionSchema', () => {
  it('accepts an empty object', () => {
    expect(bookingActionSchema.safeParse({}).success).toBe(true)
  })

  it('accepts a valid idempotency key', () => {
    expect(bookingActionSchema.safeParse({ idempotency_key: 'abcdefgh12345678' }).success).toBe(true)
  })
})
