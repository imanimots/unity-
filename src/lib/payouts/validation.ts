import { z } from 'zod'
import { idempotencyKeySchema } from '@/lib/bookings/validation'
import { PAYOUT_FAILURE_CATEGORIES, PAYOUT_METHODS } from './status-labels'

export const adminMarkProcessingSchema = z.object({
  reason: z.string().trim().max(1000).optional(),
  idempotency_key: idempotencyKeySchema.optional(),
})

export const adminRetryPayoutSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
  idempotency_key: idempotencyKeySchema.optional(),
})

export const adminMarkPaidSchema = z.object({
  payoutReference: z.string().trim().min(1).max(200),
  payoutMethod: z.enum(PAYOUT_METHODS as [string, ...string[]]),
  confirmManualPayment: z.literal(true),
  reason: z.string().trim().max(1000).optional(),
  idempotency_key: idempotencyKeySchema.optional(),
})

export const adminMarkFailedSchema = z.object({
  failureCategory: z.enum(PAYOUT_FAILURE_CATEGORIES as [string, ...string[]]),
  reason: z.string().trim().min(1).max(1000),
  idempotency_key: idempotencyKeySchema.optional(),
})

export type AdminMarkProcessingRequest = z.infer<typeof adminMarkProcessingSchema>
export type AdminRetryPayoutRequest = z.infer<typeof adminRetryPayoutSchema>
export type AdminMarkPaidRequest = z.infer<typeof adminMarkPaidSchema>
export type AdminMarkFailedRequest = z.infer<typeof adminMarkFailedSchema>
