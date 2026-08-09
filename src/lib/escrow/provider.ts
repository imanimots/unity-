/**
 * Escrow provider abstraction (Phase 3). Mirrors
 * src/lib/payments/provider.ts's exact shape -- the escrow domain talks
 * only to this interface, never to a concrete provider directly.
 *
 * TradeSafe is the PROPOSED provider for a future phase. Nothing in this
 * codebase calls TradeSafe today -- UnsupportedTradeSafeProvider is a
 * stub that throws on every method, exactly like PeachPaymentsProvider
 * does for real payments. Only MockEscrowProvider is functional. See
 * src/lib/escrow/registry.ts and docs/ESCROW_ARCHITECTURE.md.
 *
 * Escrow is a distinct financial concern from PaymentProvider: a payment
 * provider processes a charge; an escrow provider holds already-captured
 * funds in trust and later releases or refunds them. Unity commission
 * (src/lib/payments/orchestrator/create-merchant-payout.ts) and the
 * secure-transaction fee modeled here are two separate, never-summed
 * figures -- see EscrowCreateInput.secureTransactionFeeAmount.
 */

export type EscrowMockScenario = 'success' | 'declined' | 'timeout' | 'retryable_failure' | 'terminal_failure' | 'duplicate'

export type EscrowTransactionType = 'sale' | 'rental' | 'barter'

export interface EscrowCreateInput {
  transactionType: EscrowTransactionType
  /** The amount held in trust -- item price / rental fee / barter cash difference. Never includes Unity commission or the secure-transaction fee. */
  principalAmount: number
  /** A provider-charged fee for holding funds in escrow -- distinct from Unity's own platform commission, which is never touched by this domain. */
  secureTransactionFeeAmount: number
  currency: string
  mockScenario?: EscrowMockScenario
}

export interface EscrowCreateResult {
  providerReference: string
  status: 'pending'
}

export interface EscrowFundInput {
  providerReference: string
  amount: number
  currency: string
  mockScenario?: EscrowMockScenario
}

export interface EscrowFundResult {
  providerReference: string
  status: 'funded' | 'failed'
  failureReason?: string
}

export interface EscrowReleaseInput {
  providerReference: string
  amount: number
  currency: string
  mockScenario?: EscrowMockScenario
}

export interface EscrowReleaseResult {
  providerReference: string
  status: 'released' | 'failed'
  failureReason?: string
}

export interface EscrowRefundInput {
  providerReference: string
  amount: number
  currency: string
  reason?: string
  mockScenario?: EscrowMockScenario
}

export interface EscrowRefundResult {
  providerReference: string
  status: 'refunded' | 'failed'
  failureReason?: string
}

/** Same generic-header-bag shape as WebhookVerificationInput in payments/provider.ts, for the same reason -- a real escrow provider may need multiple differently-named headers. */
export interface EscrowWebhookVerificationInput {
  rawBody: string
  headers: Record<string, string | null>
}

export interface EscrowWebhookVerificationResult {
  valid: boolean
  providerEventId: string | null
  payload: unknown
}

export interface EscrowHealthCheckResult {
  healthy: boolean
  provider: string
  detail?: string
}

/**
 * What a given provider can actually do -- read before attempting an
 * operation a provider doesn't support, never discovered by a failed
 * call. Every flag defaults to what MockEscrowProvider supports; a real
 * provider adapter states its own limits here instead of the caller
 * guessing.
 */
export interface EscrowProviderCapabilities {
  supportsPartialRefund: boolean
  supportsManualFunding: boolean
  requiresWebhookConfirmation: boolean
}

export interface EscrowProvider {
  readonly name: string
  readonly capabilities: EscrowProviderCapabilities

  createEscrowTransaction(input: EscrowCreateInput): Promise<EscrowCreateResult>
  fundEscrowTransaction(input: EscrowFundInput): Promise<EscrowFundResult>
  releaseEscrowTransaction(input: EscrowReleaseInput): Promise<EscrowReleaseResult>
  refundEscrowTransaction(input: EscrowRefundInput): Promise<EscrowRefundResult>
  verifyWebhook(input: EscrowWebhookVerificationInput): Promise<EscrowWebhookVerificationResult>
  healthCheck(): Promise<EscrowHealthCheckResult>
}

export class EscrowNotImplementedError extends Error {
  constructor(provider: string, method: string) {
    super(`${provider} does not implement ${method}() -- TradeSafe is a proposed provider only, not yet integrated. See docs/ESCROW_ARCHITECTURE.md.`)
    this.name = 'EscrowNotImplementedError'
  }
}
