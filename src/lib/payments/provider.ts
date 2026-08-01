/**
 * Payment provider abstraction. The booking/payment engine talks only to
 * this interface -- it never knows whether Peach Payments, PayFast,
 * Stripe, or the MockProvider is actually behind it. See
 * src/lib/payments/registry.ts for how a provider is selected, and
 * docs/PAYMENT_ARCHITECTURE.md for the full design.
 *
 * No implementation of this interface calls a real payment gateway in
 * this phase -- see MockProvider (fully functional, simulates outcomes
 * in-memory) and PeachPaymentsProvider (stub, throws NotImplementedError
 * on every method).
 */

/**
 * Deterministic outcome selector for testing -- consulted only by
 * MockProvider. Never randomness: a test that wants a decline, a
 * timeout, or a retryable failure asks for it explicitly and gets it
 * every time. A real provider implementation (PeachPaymentsProvider)
 * ignores this field entirely -- it isn't part of what a real gateway
 * understands, only of what this codebase's own test double understands.
 */
export type MockScenario = 'success' | 'declined' | 'timeout' | 'retryable_failure' | 'terminal_failure' | 'duplicate'

export interface PaymentIntentInput {
  bookingId: string
  amount: number
  currency: string
  mockScenario?: MockScenario
}

export interface PaymentIntentResult {
  providerReference: string
  status: 'pending'
}

export interface DepositInput {
  paymentId: string
  providerReference: string
  amount: number
  currency: string
  mockScenario?: MockScenario
}

export interface DepositResult {
  providerReference: string
  status: 'authorised' | 'captured' | 'released' | 'failed'
  failureReason?: string
}

export interface ChargeInput {
  paymentId: string
  providerReference: string
  amount: number
  currency: string
  mockScenario?: MockScenario
}

export interface ChargeResult {
  providerReference: string
  status: 'captured' | 'failed'
  failureReason?: string
}

export interface RefundInput {
  paymentId: string
  providerReference: string
  amount: number
  currency: string
  reason?: string
  mockScenario?: MockScenario
}

export interface RefundResult {
  providerReference: string
  status: 'completed' | 'failed'
  failureReason?: string
}

export interface MerchantPayoutInput {
  merchantId: string
  amount: number
  currency: string
  mockScenario?: MockScenario
}

export interface MerchantPayoutResult {
  providerReference: string
  status: 'pending' | 'paid' | 'failed'
}

/**
 * `headers` is a generic bag (lower-cased header names -> value) rather
 * than a single `signatureHeader` string -- a real incompatibility found
 * during Phase 2D discovery, not a hypothetical one: Peach's Checkout
 * webhooks need four headers to reconstruct the signed string
 * (`x-webhook-signature`, `x-webhook-timestamp`, `x-webhook-id`,
 * `x-webhook-signature-algorithm`), and its OPPWA webhooks are encrypted
 * (AES-256-GCM), needing two different headers
 * (`x-initialization-vector`, `x-authentication-tag`) instead of a
 * signature at all. A single string can't carry either. Each provider's
 * verifyWebhook() reads only the headers it actually needs -- MockProvider
 * still just reads `headers['x-mock-signature']`. See
 * docs/PEACH_INTEGRATION.md "Webhook mapping".
 */
export interface WebhookVerificationInput {
  rawBody: string
  headers: Record<string, string | null>
}

export interface WebhookVerificationResult {
  valid: boolean
  providerEventId: string | null
  payload: unknown
}

export interface HealthCheckResult {
  healthy: boolean
  provider: string
  detail?: string
}

export interface PaymentProvider {
  readonly name: string

  createPaymentIntent(input: PaymentIntentInput): Promise<PaymentIntentResult>
  authorizeDeposit(input: DepositInput): Promise<DepositResult>
  captureDeposit(input: DepositInput): Promise<DepositResult>
  releaseDeposit(input: DepositInput): Promise<DepositResult>
  chargeRental(input: ChargeInput): Promise<ChargeResult>
  refund(input: RefundInput): Promise<RefundResult>
  createMerchantPayout(input: MerchantPayoutInput): Promise<MerchantPayoutResult>
  verifyWebhook(input: WebhookVerificationInput): Promise<WebhookVerificationResult>
  healthCheck(): Promise<HealthCheckResult>
}

export class NotImplementedError extends Error {
  constructor(provider: string, method: string) {
    super(`${provider} does not implement ${method}() yet -- Phase 2C builds the abstraction only, no real provider integration.`)
    this.name = 'NotImplementedError'
  }
}
