import { z } from 'zod'

const idempotencyKeySchema = z.string().min(1).max(128).optional()

export const accountStatusActionSchema = z.object({
  user_reason: z.string().max(500).nullable().optional(),
  internal_note: z.string().max(2000).nullable().optional(),
  idempotency_key: idempotencyKeySchema,
})

export const restoreAccountSchema = z.object({
  internal_note: z.string().max(2000).nullable().optional(),
  idempotency_key: idempotencyKeySchema,
})

export const addNoteSchema = z.object({
  note: z.string().min(1).max(2000),
  idempotency_key: idempotencyKeySchema,
})

export const resolveExceptionSchema = z.object({
  exception_type: z.string().min(1).max(100),
  entity_type: z.enum(['booking', 'listing', 'user', 'email_delivery']),
  note: z.string().max(1000).nullable().optional(),
})

export const emailRetrySchema = z.object({
  idempotency_key: idempotencyKeySchema,
})
