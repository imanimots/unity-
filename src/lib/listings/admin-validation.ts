import { z } from 'zod'

const idempotencyKeySchema = z.string().min(1).max(128).optional()
const reasonCodeSchema = z.string().min(1).max(100).nullable().optional()
const noteSchema = z.string().max(2000).nullable().optional()

export const startReviewSchema = z.object({ idempotency_key: idempotencyKeySchema })

export const ownershipDecisionSchema = z.object({
  reason_code: reasonCodeSchema,
  reviewer_notes: noteSchema,
  merchant_feedback: noteSchema,
  idempotency_key: idempotencyKeySchema,
})

export const moderationDecisionSchema = z.object({
  reason_code: reasonCodeSchema,
  internal_note: noteSchema,
  merchant_feedback: noteSchema,
  idempotency_key: idempotencyKeySchema,
})

export const activateSchema = z.object({ idempotency_key: idempotencyKeySchema })

export const suspendSchema = z.object({
  reason_code: reasonCodeSchema,
  internal_note: noteSchema,
  merchant_feedback: noteSchema,
  idempotency_key: idempotencyKeySchema,
})

export const evidenceUrlSchema = z.object({ media_id: z.string().uuid() })
