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

/**
 * P5C.1: a discriminated union, not a single interface with an optional
 * field -- `redirectUrl` only exists to *ask the shopper to act* (a
 * Hosted Checkout session was created but hasn't resolved yet), and
 * TypeScript enforces that no caller can read it without first
 * narrowing on `status === 'requires_action'`. This is the fix for the
 * gap P5C discovered: creating a Hosted Checkout session is inherently
 * asynchronous (Peach's response reflects "a session now exists", not
 * "the shopper paid"), so a provider that only had `'authorised' |
 * 'captured' | 'released' | 'failed'` to choose from had no honest value
 * to return. `requires_action` is a genuinely new intermediate state,
 * never a hidden synonym for success or failure -- see
 * docs/PAYMENT_ARCHITECTURE.md and every orchestrator caller's own
 * handling of it (never transitions `payments.status` away from
 * `pending` for this branch; P5D's webhook/reconciliation layer alone
 * resolves it to a terminal state).
 */
export type DepositResult =
  | { status: 'authorised'; providerReference: string }
  | { status: 'captured'; providerReference: string }
  | { status: 'released'; providerReference: string }
  | { status: 'requires_action'; providerReference: string; redirectUrl: string }
  | { status: 'failed'; providerReference: string; failureReason?: string }

export interface ChargeInput {
  paymentId: string
  providerReference: string
  amount: number
  currency: string
  mockScenario?: MockScenario
}

/** Mirrors DepositResult's discriminated-union shape and rationale above. */
export type ChargeResult =
  | { status: 'captured'; providerReference: string }
  | { status: 'requires_action'; providerReference: string; redirectUrl: string }
  | { status: 'failed'; providerReference: string; failureReason?: string }

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

/**
 * E33: Peach's own real payout lifecycle has 6 states, not the 2-3 an
 * earlier, provider-execution-less version of this interface assumed
 * -- widened once, here, for both merchant and affiliate payouts
 * rather than inventing two slightly different vocabularies.
 * 'pending'/'processing' are both genuinely non-final; only
 * 'successful' may ever mark a domain row paid, and 'reversed' can
 * arrive after 'successful' (see docs/PEACH_INTEGRATION.md §18 and
 * the E33 migration's own header comment for the full domain mapping).
 */
export type ProviderPayoutStatus = 'pending' | 'processing' | 'successful' | 'failed' | 'cancelled' | 'reversed'

/**
 * E33: amount/accountNumber/bankName/etc are already server-resolved
 * by the orchestrator (via the E32 destination authority + E33's
 * start_*_provider_attempt RPC) BEFORE this is ever called -- a
 * provider implementation never fetches banking/identity data itself
 * (phase brief §33). payoutId is Unity's own provider_payout_id, a
 * genuine v4 UUID persisted before this call is ever made.
 */
export interface MerchantPayoutInput {
  merchantId: string
  payoutId: string
  reference: string
  amount: number
  amountMinorUnits: number
  currency: string
  bankName: string
  branchCode: string
  accountNumber: string
  accountHolder: string
  mockScenario?: MockScenario
}

export interface MerchantPayoutResult {
  providerPayoutId: string
  providerRequestId?: string
  status: ProviderPayoutStatus
  resultCode?: string
  failureReason?: string
}

/**
 * Step 11 Phase 7 -- affiliate commission payouts. Deliberately its own
 * method, not a reuse of createMerchantPayout(): a merchant payout can
 * cover many bookings at once (a batching concept that doesn't apply
 * here -- affiliate payouts are always 1:1 with one commission row),
 * and the two recipient types are financially distinct ledgers.
 */
export interface AffiliatePayoutInput {
  affiliateId: string
  commissionId: string
  payoutId: string
  reference: string
  amount: number
  amountMinorUnits: number
  currency: string
  bankName: string
  branchCode: string
  accountNumber: string
  accountHolder: string
  mockScenario?: MockScenario
}

export interface AffiliatePayoutResult {
  providerPayoutId: string
  providerRequestId?: string
  status: ProviderPayoutStatus
  resultCode?: string
  failureReason?: string
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

/**
 * E30: an explicit, self-reported capability model -- each provider's own
 * class states what it actually supports, right next to the methods
 * themselves, rather than a separate table that could drift from the
 * real implementation. Introduced specifically because two of these
 * (`refund`, `affiliate_payout`) have real orchestrator call sites that
 * mark a DB row 'processing' BEFORE calling the provider -- an unknown-
 * in-advance capability gap must reject before that mutation, never
 * after. As of E33, `merchant_payout` also has a real orchestrator
 * call site -- merchant payouts are no longer exclusively admin-
 * attested; a real provider-execution path now coexists alongside the
 * pre-existing manual one (see the E33 migration's own "manual-flow
 * conflict guard" for how the two stay mutually exclusive at any given
 * moment).
 */
export type PaymentCapability =
  | 'charge_rental'
  | 'authorize_deposit'
  | 'capture_deposit'
  | 'release_deposit'
  | 'refund'
  | 'merchant_payout'
  | 'affiliate_payout'
  | 'webhook_verification'

export interface PaymentProvider {
  readonly name: string

  createPaymentIntent(input: PaymentIntentInput): Promise<PaymentIntentResult>
  authorizeDeposit(input: DepositInput): Promise<DepositResult>
  captureDeposit(input: DepositInput): Promise<DepositResult>
  releaseDeposit(input: DepositInput): Promise<DepositResult>
  chargeRental(input: ChargeInput): Promise<ChargeResult>
  refund(input: RefundInput): Promise<RefundResult>
  createMerchantPayout(input: MerchantPayoutInput): Promise<MerchantPayoutResult>
  createAffiliatePayout(input: AffiliatePayoutInput): Promise<AffiliatePayoutResult>
  verifyWebhook(input: WebhookVerificationInput): Promise<WebhookVerificationResult>
  healthCheck(): Promise<HealthCheckResult>
  supportsCapability(capability: PaymentCapability): boolean
}

export class NotImplementedError extends Error {
  constructor(provider: string, method: string) {
    super(`${provider} does not implement ${method}() yet -- Phase 2C builds the abstraction only, no real provider integration.`)
    this.name = 'NotImplementedError'
  }
}

/**
 * E30: thrown by assertProviderSupportsCapability() (registry.ts) --
 * distinct from NotImplementedError, which a provider throws from
 * *inside* a method it was actually called into. This is thrown
 * *before* that call, by the caller's own pre-flight check, so an
 * orchestrator can reject a known-unsupported operation before any DB
 * row is marked 'processing' -- never after.
 */
export class ProviderCapabilityUnsupportedError extends Error {
  constructor(provider: string, capability: PaymentCapability) {
    super(`Payment provider "${provider}" does not support the "${capability}" capability.`)
    this.name = 'ProviderCapabilityUnsupportedError'
  }
}
