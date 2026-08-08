import { z } from 'zod'
import { idempotencyKeySchema } from '@/lib/bookings/validation'

export const adminCommissionOverrideSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
  idempotency_key: idempotencyKeySchema.optional(),
})

export const adminCommissionAdjustmentSchema = z.object({
  amount: z.number().finite(),
  reason: z.string().trim().min(1).max(1000),
  idempotency_key: idempotencyKeySchema.optional(),
})

export const adminCommissionReleaseSchema = z.object({
  idempotency_key: idempotencyKeySchema.optional(),
})

export type AdminCommissionOverrideRequest = z.infer<typeof adminCommissionOverrideSchema>
export type AdminCommissionAdjustmentRequest = z.infer<typeof adminCommissionAdjustmentSchema>
