import { z } from 'zod'
import { idempotencyKeySchema } from '@/lib/bookings/validation'
import { MERCHANT_SUBSCRIPTION_PLAN_IDS } from './plans'
import { SUBSCRIPTION_MOCK_SCENARIOS } from './billing/test-scenario'

const planIdSchema = z.enum(MERCHANT_SUBSCRIPTION_PLAN_IDS as [string, ...string[]])

/**
 * No billingReference field here on purpose -- accepting one from the
 * client would let a merchant forge "I already paid" and skip billing
 * entirely. The upgrade route always obtains its own billing_reference
 * server-side via attemptSubscriptionBilling(); mockScenario is the only
 * client-influenceable input, and only ever consulted when
 * isSubscriptionMockScenarioSelectionAllowed() is true (mock provider +
 * non-production), mirroring the checkout domain's test_scenario gate.
 */
export const requestUpgradeSchema = z.object({
  targetPlanId: planIdSchema,
  mockScenario: z.enum(SUBSCRIPTION_MOCK_SCENARIOS as [string, ...string[]]).optional(),
  idempotency_key: idempotencyKeySchema.optional(),
})

const downgradeReasonCategorySchema = z.enum(['too_expensive', 'not_using_features', 'switching_platform', 'business_paused', 'other'])

const keepSetEntitySchema = z.object({
  entityType: z.enum(['listing', 'marketplace_request', 'barter_skill_task_post']),
  entityId: z.string().uuid(),
})

/** Downgrade/cancellation never require a billing reference -- the RPC's
 * own branching handles that (see request_merchant_plan_change). A
 * reason and, when the target plan's cap is below current usage, a
 * keep-set are both server-validated here AND re-validated inside the
 * RPCs themselves -- this schema only rejects obviously malformed
 * input early, it is never the actual enforcement point. */
export const requestDowngradeSchema = z.object({
  targetPlanId: planIdSchema,
  reasonCategory: downgradeReasonCategorySchema,
  reasonText: z.string().trim().max(1000).optional(),
  acknowledgedChangeKeys: z.array(z.string()).default([]),
  keepSetEntities: z.array(keepSetEntitySchema).max(500).optional(),
  idempotency_key: idempotencyKeySchema.optional(),
})

/** Cancelling down to Starter is itself a downgrade -- same reason/
 * acknowledgement/keep-set requirements, just without a targetPlanId
 * (always 'starter'). */
export const cancelSubscriptionSchema = z.object({
  reasonCategory: downgradeReasonCategorySchema,
  reasonText: z.string().trim().max(1000).optional(),
  acknowledgedChangeKeys: z.array(z.string()).default([]),
  keepSetEntities: z.array(keepSetEntitySchema).max(500).optional(),
  idempotency_key: idempotencyKeySchema.optional(),
})

export const cancelPendingPlanChangeSchema = z.object({
  idempotency_key: idempotencyKeySchema.optional(),
})

export const adminCorrectSubscriptionSchema = z.object({
  newPlanId: planIdSchema,
  immediate: z.boolean(),
  reason: z.string().trim().min(1).max(1000),
  idempotency_key: idempotencyKeySchema.optional(),
})

export type RequestUpgradeRequest = z.infer<typeof requestUpgradeSchema>
export type RequestDowngradeRequest = z.infer<typeof requestDowngradeSchema>
export type CancelPendingPlanChangeRequest = z.infer<typeof cancelPendingPlanChangeSchema>
export type AdminCorrectSubscriptionRequest = z.infer<typeof adminCorrectSubscriptionSchema>
