import { z } from 'zod'

export const idempotencyKeySchema = z.string().min(8).max(128)

export const eraseAccountRequestSchema = z.object({
  idempotency_key: idempotencyKeySchema.optional(),
})

export const adminEraseAccountRequestSchema = z.object({
  internal_note: z.string().max(2000).nullable().optional(),
  idempotency_key: idempotencyKeySchema.optional(),
})
