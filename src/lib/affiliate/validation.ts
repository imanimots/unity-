import { z } from 'zod'
import { idempotencyKeySchema } from '@/lib/bookings/validation'

export const attributionRequestSchema = z.object({
  listing_id: z.string().uuid(),
  referral_code: z.string().trim().min(1).max(64),
  idempotency_key: idempotencyKeySchema.optional(),
})

export const listingAffiliateToggleSchema = z.object({
  idempotency_key: idempotencyKeySchema.optional(),
})

export const adminAffiliateOverrideSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
  idempotency_key: idempotencyKeySchema.optional(),
})

export const adminAffiliateAdjustmentSchema = z.object({
  amount: z.number().finite(),
  reason: z.string().trim().min(1).max(1000),
  idempotency_key: idempotencyKeySchema.optional(),
})

export const adminAffiliateReleaseSchema = z.object({
  idempotency_key: idempotencyKeySchema.optional(),
})

export type AttributionRequest = z.infer<typeof attributionRequestSchema>
export type AdminAffiliateOverrideRequest = z.infer<typeof adminAffiliateOverrideSchema>
export type AdminAffiliateAdjustmentRequest = z.infer<typeof adminAffiliateAdjustmentSchema>
