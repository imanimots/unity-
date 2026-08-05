import { z } from 'zod'
import { idempotencyKeySchema } from '@/lib/bookings/validation'

const deliveryMethodEnum = z.enum(['meet_in_person', 'courier', 'self_collection', 'other'] as const)
const deliveryResponsibilityEnum = z.enum(['party_a', 'party_b', 'shared', 'each_handles_own', 'not_applicable'] as const)
const depositPayerEnum = z.enum(['party_a', 'party_b', 'both'] as const)

// Shared by propose_barter and counter_barter_offer -- every offer version
// is a complete replacement package (full item lists for both sides, full
// terms), never a partial diff against the previous version.
const offerFields = {
  party_a_listing_ids: z.array(z.string().uuid()).min(1, 'At least one listing must be requested from the other party').max(20),
  party_b_listing_ids: z.array(z.string().uuid()).min(1, 'At least one listing must be offered').max(20),
  cash_adjustment_amount: z.number().min(0).max(1_000_000).optional(),
  cash_adjustment_payer: z.string().uuid().optional(),
  delivery_method: deliveryMethodEnum,
  delivery_notes: z.string().trim().max(1000).optional(),
  delivery_responsibility: deliveryResponsibilityEnum.optional(),
  deposit_required: z.boolean().optional(),
  deposit_amount: z.number().positive().max(1_000_000).optional(),
  deposit_currency: z.string().length(3).optional(),
  deposit_payer: depositPayerEnum.optional(),
  message: z.string().trim().max(2000).optional(),
  idempotency_key: idempotencyKeySchema.optional(),
}

// Cross-field consistency, mirrored from the DB's own barter_offers_*_chk
// constraints so the client gets a clean 400 instead of a raw constraint
// violation surfacing as a generic 500 through the RPC error mapper.
// Typed against a plain interface (not a generic z.infer<T>) since Zod's
// inferred type inside a generic refine callback doesn't narrow to the
// caller's concrete shape.
interface OfferFieldsForRefine {
  deposit_required?: boolean
  deposit_amount?: number
  deposit_payer?: string
  cash_adjustment_amount?: number
  cash_adjustment_payer?: string
}

function depositConsistent(data: OfferFieldsForRefine): boolean {
  return !data.deposit_required || (!!data.deposit_amount && !!data.deposit_payer)
}

function cashAdjustmentConsistent(data: OfferFieldsForRefine): boolean {
  return !data.cash_adjustment_amount || data.cash_adjustment_amount === 0 || !!data.cash_adjustment_payer
}

export const proposeBarterSchema = z.object({
  anchor_listing_id: z.string().uuid(),
  ...offerFields,
})
  .refine(depositConsistent, { message: 'Deposit amount and payer are required when a deposit is requested', path: ['deposit_amount'] })
  .refine(cashAdjustmentConsistent, { message: 'A payer must be specified when a cash adjustment is included', path: ['cash_adjustment_payer'] })

export const counterBarterOfferSchema = z.object(offerFields)
  .refine(depositConsistent, { message: 'Deposit amount and payer are required when a deposit is requested', path: ['deposit_amount'] })
  .refine(cashAdjustmentConsistent, { message: 'A payer must be specified when a cash adjustment is included', path: ['cash_adjustment_payer'] })

export const rejectBarterSchema = z.object({
  rejection_reason: z.string().trim().max(1000).optional(),
  idempotency_key: idempotencyKeySchema.optional(),
})

export const cancelBarterSchema = z.object({
  cancellation_reason: z.string().trim().max(1000).optional(),
  idempotency_key: idempotencyKeySchema.optional(),
})

// accept has no business fields of its own -- only an optional idempotency key.
export const barterActionSchema = z.object({
  idempotency_key: idempotencyKeySchema.optional(),
})

// ── Step 11 Phase 4 additions ──

// Mirrors MockScenario's own literal values directly rather than a
// booking-checkout-style normalized indirection layer (CheckoutTestScenario)
// -- barter deposit/cash-adjustment routes each make exactly ONE provider
// call, so there's no dual-step (rental+deposit) ambiguity to normalize
// away. Still gated the same way (isMockScenarioSelectionAllowed()).
const mockScenarioEnum = z.enum(['success', 'declined', 'timeout', 'retryable_failure', 'terminal_failure', 'duplicate'] as const)

export const payBarterDepositSchema = z.object({
  test_scenario: mockScenarioEnum.optional(),
  idempotency_key: idempotencyKeySchema.optional(),
})

export const payBarterCashAdjustmentSchema = z.object({
  test_scenario: mockScenarioEnum.optional(),
  idempotency_key: idempotencyKeySchema.optional(),
})

export const markBarterProgressSchema = z.object({
  target_status: z.enum(['preparing', 'in_transit', 'awaiting_confirmation'] as const),
  idempotency_key: idempotencyKeySchema.optional(),
})

export const confirmBarterCompletionSchema = z.object({
  confirmation_note: z.string().trim().max(1000).optional(),
  idempotency_key: idempotencyKeySchema.optional(),
})

export const adminSetBarterHoldSchema = z.object({
  hold: z.boolean(),
  reason: z.string().trim().max(1000).optional(),
  idempotency_key: idempotencyKeySchema.optional(),
})

export const adminCancelBarterSchema = z.object({
  reason: z.string().trim().max(1000).optional(),
  idempotency_key: idempotencyKeySchema.optional(),
})

export type ProposeBarterRequest = z.infer<typeof proposeBarterSchema>
export type CounterBarterOfferRequest = z.infer<typeof counterBarterOfferSchema>
export type RejectBarterRequest = z.infer<typeof rejectBarterSchema>
export type CancelBarterRequest = z.infer<typeof cancelBarterSchema>
export type BarterActionRequest = z.infer<typeof barterActionSchema>
export type PayBarterDepositRequest = z.infer<typeof payBarterDepositSchema>
export type PayBarterCashAdjustmentRequest = z.infer<typeof payBarterCashAdjustmentSchema>
export type MarkBarterProgressRequest = z.infer<typeof markBarterProgressSchema>
export type ConfirmBarterCompletionRequest = z.infer<typeof confirmBarterCompletionSchema>
export type AdminSetBarterHoldRequest = z.infer<typeof adminSetBarterHoldSchema>
export type AdminCancelBarterRequest = z.infer<typeof adminCancelBarterSchema>
