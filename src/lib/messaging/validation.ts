import { z } from 'zod'
import { idempotencyKeySchema } from '@/lib/bookings/validation'

const threadRefFields = {
  booking_id: z.string().uuid().optional(),
  order_id: z.string().uuid().optional(),
  barter_agreement_id: z.string().uuid().optional(),
  dispute_id: z.string().uuid().optional(),
}

function exactlyOneThreadRef(v: { booking_id?: string; order_id?: string; barter_agreement_id?: string; dispute_id?: string }): boolean {
  return [v.booking_id, v.order_id, v.barter_agreement_id, v.dispute_id].filter((x) => x !== undefined).length === 1
}

const THREAD_REF_ERROR = { message: 'Exactly one of booking_id, order_id, barter_agreement_id, or dispute_id is required' }

// Exactly one of booking_id/order_id/barter_agreement_id/dispute_id,
// mirroring messages_one_transaction_chk (plus the additive dispute_id
// tag) -- enforced again here so a malformed request gets a clean 400
// before ever reaching resolveThread()/the database.
export const sendMessageSchema = z
  .object({
    ...threadRefFields,
    content: z.string().trim().min(1).max(2000),
    idempotency_key: idempotencyKeySchema.optional(),
  })
  .refine(exactlyOneThreadRef, THREAD_REF_ERROR)

export const listMessagesQuerySchema = z
  .object({
    ...threadRefFields,
    // Opaque (created_at, id) keyset cursor -- see src/lib/messaging/cursor.ts
    // for why created_at alone can't safely order/paginate this table.
    // Bounded the same way every other cursor in this repo is (2048-char
    // cap enforced again in cursor.ts; malformed/oversized -> null ->
    // InvalidMessagesCursorError -> 400, never a crash).
    cursor: z.string().max(2048).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .refine(exactlyOneThreadRef, THREAD_REF_ERROR)

export const attachmentRegisterSchema = z.object({
  storage_path: z.string().min(1).max(500),
  file_type: z.enum(['image', 'pdf', 'document']),
  idempotency_key: idempotencyKeySchema.optional(),
})

export type SendMessageRequest = z.infer<typeof sendMessageSchema>
export type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>
export type AttachmentRegisterRequest = z.infer<typeof attachmentRegisterSchema>
