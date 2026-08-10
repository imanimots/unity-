import { z } from 'zod'
import { idempotencyKeySchema } from '@/lib/bookings/validation'

// Exactly one of booking_id/order_id/barter_agreement_id/
// rent_to_buy_agreement_id, mirroring disputes_one_transaction_chk.
// Enforced again here (not just left to the RPC) so a malformed
// request gets a clean 400 before ever reaching the database.
export const openDisputeSchema = z
  .object({
    booking_id: z.string().uuid().optional(),
    order_id: z.string().uuid().optional(),
    barter_agreement_id: z.string().uuid().optional(),
    rent_to_buy_agreement_id: z.string().uuid().optional(),
    title: z.string().trim().min(1).max(200),
    reason: z.string().trim().max(200).optional(),
    description: z.string().trim().min(1).max(5000),
    requested_resolution: z.string().trim().min(1).max(2000),
    idempotency_key: idempotencyKeySchema.optional(),
  })
  .refine(
    (v) => [v.booking_id, v.order_id, v.barter_agreement_id, v.rent_to_buy_agreement_id].filter((x) => x !== undefined).length === 1,
    { message: 'Exactly one of booking_id, order_id, barter_agreement_id, or rent_to_buy_agreement_id is required' }
  )

export const disputeEvidenceRegisterSchema = z.object({
  storage_path: z.string().min(1).max(500),
  file_type: z.enum(['image', 'pdf', 'document']),
  display_order: z.number().int().min(0).max(100).optional(),
  idempotency_key: idempotencyKeySchema.optional(),
})

export const disputeMessageSchema = z.object({
  content: z.string().trim().min(1).max(2000),
})

export const assignDisputeSchema = z.object({
  assignee_admin_id: z.string().uuid(),
  idempotency_key: idempotencyKeySchema.optional(),
})

export const requestDisputeEvidenceSchema = z.object({
  note: z.string().trim().max(2000).optional(),
  idempotency_key: idempotencyKeySchema.optional(),
})

export const resolveDisputeSchema = z.object({
  outcome: z.enum(['favor_raiser', 'favor_respondent', 'mutual_agreement', 'manual_settlement']),
  resolution_notes: z.string().trim().max(5000).optional(),
  idempotency_key: idempotencyKeySchema.optional(),
})

export const cancelDisputeSchema = z.object({
  cancellation_reason: z.string().trim().max(1000).optional(),
  idempotency_key: idempotencyKeySchema.optional(),
})

// assign-review / close take no business fields beyond an idempotency key.
export const disputeActionSchema = z.object({
  idempotency_key: idempotencyKeySchema.optional(),
})

export type OpenDisputeRequest = z.infer<typeof openDisputeSchema>
export type ResolveDisputeRequest = z.infer<typeof resolveDisputeSchema>
export type CancelDisputeRequest = z.infer<typeof cancelDisputeSchema>
