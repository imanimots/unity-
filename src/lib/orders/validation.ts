import { z } from 'zod'
import { idempotencyKeySchema } from '@/lib/bookings/validation'

// An order has exactly one charge (no separate rental-vs-deposit split
// the way bookings do), so checkout accepts a raw MockScenario value
// directly rather than the booking-specific normalized-scenario mapping
// layer (src/lib/checkout/test-scenario.ts) -- there is no "which step
// is this for" ambiguity to abstract away.
export const orderCheckoutRequestSchema = z.object({
  idempotency_key: z.string().min(8).max(128),
  test_scenario: z.enum(['success', 'declined', 'timeout', 'retryable_failure', 'terminal_failure', 'duplicate']).optional(),
})

export const createOrderRequestSchema = z.object({
  listing_id: z.string().uuid(),
  quantity: z.number().int().min(1).max(100).default(1),
  idempotency_key: idempotencyKeySchema.optional(),
})

export const cancelOrderSchema = z.object({
  cancellation_reason: z.string().trim().max(1000).optional(),
  idempotency_key: idempotencyKeySchema.optional(),
})

// ship / confirm-delivery take no business fields -- only an optional idempotency key.
export const orderActionSchema = z.object({
  idempotency_key: idempotencyKeySchema.optional(),
})

export type CreateOrderRequest = z.infer<typeof createOrderRequestSchema>
export type CancelOrderRequest = z.infer<typeof cancelOrderSchema>
export type OrderActionRequest = z.infer<typeof orderActionSchema>
