import { z } from 'zod'
import { idempotencyKeySchema } from '@/lib/bookings/validation'

const frequencyEnum = z.enum(['weekly', 'biweekly', 'monthly'] as const)

export const saveRentToBuyListingTermsSchema = z.object({
  enabled: z.boolean(),
  currency: z.string().length(3).optional(),
  total_purchase_price: z.number().positive().max(10_000_000),
  installment_amount: z.number().positive().max(10_000_000),
  payment_frequency: frequencyEnum,
  installment_count: z.number().int().positive().max(520),
  security_deposit_amount: z.number().min(0).max(10_000_000).optional(),
  early_payoff_allowed: z.boolean().optional(),
  early_payoff_policy: z.record(z.string(), z.unknown()).optional(),
  default_cure_allowed: z.boolean().optional(),
  cure_policy: z.record(z.string(), z.unknown()).optional(),
})

export const createRentToBuyRequestSchema = z.object({
  listing_id: z.string().uuid(),
  idempotency_key: idempotencyKeySchema.optional(),
})

export const rentToBuyActionSchema = z.object({
  idempotency_key: idempotencyKeySchema.optional(),
})

export const rentToBuyDeclineSchema = z.object({
  reason: z.string().trim().max(500).optional(),
  idempotency_key: idempotencyKeySchema.optional(),
})

export const rentToBuyDefaultSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
  idempotency_key: idempotencyKeySchema.optional(),
})

export const rentToBuyReturnRequestSchema = z.object({
  condition_notes: z.string().trim().max(1000).optional(),
  idempotency_key: idempotencyKeySchema.optional(),
})
