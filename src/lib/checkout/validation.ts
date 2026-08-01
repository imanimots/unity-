import { z } from 'zod'
import { CHECKOUT_TEST_SCENARIOS } from './test-scenario'

// idempotency_key is required (not optional) for checkout, unlike most
// booking actions -- every checkout attempt must carry its own key so a
// browser retry/double-click always maps to a single logical attempt.
export const checkoutRequestSchema = z.object({
  idempotency_key: z.string().min(8).max(128),
  test_scenario: z.enum(CHECKOUT_TEST_SCENARIOS).optional(),
})

export type CheckoutRequest = z.infer<typeof checkoutRequestSchema>
