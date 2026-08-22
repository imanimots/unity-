import { z } from 'zod'
import { idempotencyKeySchema } from '@/lib/bookings/validation'

const frequencyEnum = z.enum(['weekly', 'biweekly', 'monthly'] as const)
const possessionTriggerTypeEnum = z.enum(['first_payment', 'installment_count', 'percentage', 'full_payment'] as const)
const rateUnitEnum = z.enum(['daily', 'weekly', 'monthly'] as const)

export const saveRentToBuyListingTermsSchema = z.object({
  enabled: z.boolean(),
  currency: z.string().length(3).optional(),
  total_purchase_price: z.number().positive().max(10_000_000),
  installment_amount: z.number().positive().max(10_000_000),
  payment_frequency: frequencyEnum,
  installment_count: z.number().int().positive().max(520),
  security_deposit_amount: z.number().min(0).max(10_000_000).optional(),
  early_payoff_allowed: z.boolean().optional(),
  early_payoff_policy: z.record(z.string(), z.unknown()).optional(),
  default_cure_allowed: z.boolean().optional(),
  cure_policy: z.record(z.string(), z.unknown()).optional(),
  possession_trigger_type: possessionTriggerTypeEnum,
  possession_trigger_value: z.number().positive().optional(),
  rental_use_rate_amount: z.number().min(0).max(1_000_000),
  rental_use_rate_unit: rateUnitEnum,
  wear_damage_standard: z.string().trim().max(2000).optional(),
  grace_period_days: z.number().int().min(0).max(3650),
  return_window_days: z.number().int().min(0).max(3650),
}).refine(
  (data) => (data.possession_trigger_type === 'first_payment' || data.possession_trigger_type === 'full_payment')
    ? data.possession_trigger_value === undefined
    : data.possession_trigger_value !== undefined,
  { message: 'possession_trigger_value is required for installment_count/percentage triggers, and must be omitted for first_payment/full_payment' }
)

export const createRentToBuyRequestSchema = z.object({
  listing_id: z.string().uuid(),
  idempotency_key: idempotencyKeySchema.optional(),
})

export const rentToBuyActionSchema = z.object({
  idempotency_key: idempotencyKeySchema.optional(),
})

export const rentToBuyDeclineSchema = z.object({
  reason: z.string().trim().max(500).optional(),
  idempotency_key: idempotencyKeySchema.optional(),
})

export const rentToBuyDefaultSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
  idempotency_key: idempotencyKeySchema.optional(),
})

export const rentToBuyReturnRequestSchema = z.object({
  condition_notes: z.string().trim().max(1000).optional(),
  idempotency_key: idempotencyKeySchema.optional(),
})

export const rentToBuyMutualTerminationProposeSchema = z.object({
  reason: z.string().trim().max(1000).optional(),
  idempotency_key: idempotencyKeySchema.optional(),
})

export const rentToBuyAmendmentProposeSchema = z.object({
  proposed_changes: z.object({
    grace_period_days: z.number().int().min(0).max(3650).optional(),
    return_window_days: z.number().int().min(0).max(3650).optional(),
    installments: z.array(z.object({
      sequence: z.number().int().positive(),
      due_date: z.string(),
      principal_amount: z.number().positive(),
    })).optional(),
  }).refine((v) => Object.keys(v).length > 0, { message: 'at least one field must be proposed' }),
  reason: z.string().trim().max(1000).optional(),
  idempotency_key: idempotencyKeySchema.optional(),
})

export const rentToBuyAmendmentRespondSchema = z.object({
  accept: z.boolean(),
  decline_reason: z.string().trim().max(1000).optional(),
  idempotency_key: idempotencyKeySchema.optional(),
})

export const rentToBuyEvidenceTypeEnum = z.enum(['pre_handover', 'post_handover_receipt', 'pre_return', 'post_return'] as const)

export const rentToBuyEvidenceRegisterSchema = z.object({
  storage_path: z.string().trim().min(1).max(500),
  file_type: z.enum(['image', 'video', 'pdf'] as const),
  evidence_type: rentToBuyEvidenceTypeEnum,
  display_order: z.number().int().min(0).optional(),
  idempotency_key: idempotencyKeySchema.optional(),
})
