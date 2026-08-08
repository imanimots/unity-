/**
 * Provider-neutral mock billing abstraction for merchant subscription
 * plan charges. Deliberately separate from src/lib/payments/provider.ts
 * -- that interface models a booking/order/barter transaction's
 * lifecycle (intent -> authorize -> capture -> refund); a subscription
 * upgrade is a single, immediate "charge this plan's monthly fee" event
 * with no deposit/refund concept, and forcing it through the booking
 * shape would be a worse fit than a small dedicated interface.
 *
 * No implementation of this interface calls a real billing provider in
 * this phase -- see MockSubscriptionBillingProvider (fully functional,
 * deterministic, in-memory). "provider" stays a generic label ('mock' in
 * every environment today) in every persisted record -- never a real
 * vendor name (no Stripe/PayFast/Peach/TradeSafe references anywhere in
 * this module), so a future real billing provider slots in later via the
 * registry + env var only, matching every other provider abstraction in
 * this codebase.
 */

export type SubscriptionMockScenario = 'success' | 'declined'

export interface SubscriptionChargeInput {
  merchantId: string
  planId: string
  amountCents: number
  currency: string
  mockScenario?: SubscriptionMockScenario
}

export interface SubscriptionChargeResult {
  providerReference: string
  status: 'succeeded' | 'failed'
  failureReason?: string
}

export interface SubscriptionBillingProvider {
  readonly name: string
  chargePlan(input: SubscriptionChargeInput): Promise<SubscriptionChargeResult>
}
