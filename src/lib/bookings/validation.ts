import { z } from 'zod'

// Idempotency key convention matches src/lib/listings/validation.ts exactly
// -- a short opaque client-generated string, not necessarily a UUID.
export const idempotencyKeySchema = z.string().min(8).max(128)

export const createBookingRequestSchema = z.object({
  listing_id: z.string().uuid(),
  start_at: z.string().datetime({ offset: true }),
  end_at: z.string().datetime({ offset: true }),
  renter_message: z.string().trim().max(1000).optional(),
  idempotency_key: idempotencyKeySchema.optional(),
})

export const acceptBookingSchema = z.object({
  merchant_response_note: z.string().trim().max(1000).optional(),
  idempotency_key: idempotencyKeySchema.optional(),
})

export const rejectBookingSchema = z.object({
  rejection_reason: z.string().trim().max(1000).optional(),
  idempotency_key: idempotencyKeySchema.optional(),
})

export const cancelBookingSchema = z.object({
  cancellation_reason: z.string().trim().max(1000).optional(),
  idempotency_key: idempotencyKeySchema.optional(),
})

// start / initiate-return / confirm-return all take no business fields --
// only an optional idempotency key.
export const bookingActionSchema = z.object({
  idempotency_key: idempotencyKeySchema.optional(),
})

export type CreateBookingRequest = z.infer<typeof createBookingRequestSchema>
export type AcceptBookingRequest = z.infer<typeof acceptBookingSchema>
export type RejectBookingRequest = z.infer<typeof rejectBookingSchema>
export type CancelBookingRequest = z.infer<typeof cancelBookingSchema>
export type BookingActionRequest = z.infer<typeof bookingActionSchema>
