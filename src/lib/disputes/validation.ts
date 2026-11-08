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

// E28: financial_disposition_* fields are optional at this schema level
// because whether they are REQUIRED depends on whether this dispute is a
// booking dispute -- a fact only the route can know after fetching the
// dispute row (order/barter/RTB dispute resolution is unaffected and must
// keep working exactly as before, with none of these fields). The route
// enforces "required for a booking dispute" explicitly; Zod only enforces
// the shape of whichever fields are actually present.
export const resolveDisputeSchema = z.object({
  outcome: z.enum(['favor_raiser', 'favor_respondent', 'mutual_agreement', 'manual_settlement']),
  resolution_notes: z.string().trim().max(5000).optional(),
  financial_disposition_type: z.enum(['no_financial_adjustment', 'refund_required', 'manual_financial_settlement']).optional(),
  financial_disposition_amount: z.number().positive().optional(),
  financial_disposition_reason: z.string().trim().min(1).max(2000).optional(),
  idempotency_key: idempotencyKeySchema.optional(),
})

export const completeDisputeFinancialDispositionSchema = z.object({
  completion_notes: z.string().trim().max(2000).optional(),
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

/**
 * E28: pure, DB-free validation of a resolve-dispute request's
 * financial-disposition fields -- extracted from the route for direct
 * unit testing (this file's own established convention). Returns a
 * user-facing error string, or null if the request is valid for the
 * given domain. Order/barter/RTB disputes (isBookingDispute=false)
 * never require these fields regardless of what was submitted -- the
 * route never even reaches this check for them, but this function
 * documents and enforces the contract either way: it should be
 * impossible for a booking dispute to resolve without an explicit
 * financial disposition, exactly as explicit for favor_respondent
 * (no_financial_adjustment, with a reason) as for any other outcome.
 */
export function validateBookingFinancialDisposition(
  isBookingDispute: boolean,
  fields: Pick<ResolveDisputeRequest, 'financial_disposition_type' | 'financial_disposition_amount' | 'financial_disposition_reason'>
): string | null {
  if (!isBookingDispute) return null
  const { financial_disposition_type, financial_disposition_amount, financial_disposition_reason } = fields
  if (!financial_disposition_type) {
    return 'A financial disposition is required to resolve a booking dispute.'
  }
  if (!financial_disposition_reason) {
    return 'A reason is required for the financial disposition.'
  }
  if (financial_disposition_type === 'no_financial_adjustment' && financial_disposition_amount !== undefined) {
    return 'No financial adjustment must not include an amount.'
  }
  if (financial_disposition_type !== 'no_financial_adjustment' && financial_disposition_amount === undefined) {
    return 'An amount is required for this disposition type.'
  }
  return null
}
