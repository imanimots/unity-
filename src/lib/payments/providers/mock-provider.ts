import { randomUUID } from 'crypto'
import type {
  PaymentProvider,
  PaymentIntentInput,
  PaymentIntentResult,
  DepositInput,
  DepositResult,
  ChargeInput,
  ChargeResult,
  RefundInput,
  RefundResult,
  MerchantPayoutInput,
  MerchantPayoutResult,
  WebhookVerificationInput,
  WebhookVerificationResult,
  HealthCheckResult,
  MockScenario,
} from '../provider'
import { ProviderTimeoutError, RetryableProviderError, TerminalProviderError } from '../provider-errors'

/**
 * Fully functional but entirely simulated -- no network call, no real
 * money. Deterministic by default (mockScenario: 'success', implicit
 * when omitted); every operation returns a mock-prefixed reference, so
 * it's obvious in logs/data that nothing real happened. Used as the
 * default provider whenever mock mode is on, and directly in tests.
 *
 * Every scenario is selected explicitly via input.mockScenario -- never
 * randomly -- so a test asking for 'timeout' always gets a
 * ProviderTimeoutError, every run.
 */
export class MockProvider implements PaymentProvider {
  readonly name = 'mock'

  async createPaymentIntent(input: PaymentIntentInput): Promise<PaymentIntentResult> {
    this.applyScenario('createPaymentIntent', input.mockScenario)
    if (input.mockScenario === 'duplicate') {
      return { providerReference: 'mock_intent_duplicate', status: 'pending' }
    }
    return { providerReference: `mock_intent_${randomUUID()}`, status: 'pending' }
  }

  async authorizeDeposit(input: DepositInput): Promise<DepositResult> {
    this.applyScenario('authorizeDeposit', input.mockScenario)
    if (input.mockScenario === 'declined') {
      return { providerReference: input.providerReference, status: 'failed', failureReason: 'card declined' }
    }
    if (input.mockScenario === 'duplicate') {
      return { providerReference: 'mock_auth_duplicate', status: 'authorised' }
    }
    return { providerReference: input.providerReference || `mock_auth_${randomUUID()}`, status: 'authorised' }
  }

  async captureDeposit(input: DepositInput): Promise<DepositResult> {
    this.applyScenario('captureDeposit', input.mockScenario)
    return { providerReference: input.providerReference, status: 'captured' }
  }

  async releaseDeposit(input: DepositInput): Promise<DepositResult> {
    this.applyScenario('releaseDeposit', input.mockScenario)
    return { providerReference: input.providerReference, status: 'released' }
  }

  async chargeRental(input: ChargeInput): Promise<ChargeResult> {
    this.applyScenario('chargeRental', input.mockScenario)
    if (input.mockScenario === 'declined') {
      return { providerReference: input.providerReference, status: 'failed', failureReason: 'card declined' }
    }
    if (input.mockScenario === 'duplicate') {
      return { providerReference: 'mock_charge_duplicate', status: 'captured' }
    }
    return { providerReference: input.providerReference || `mock_charge_${randomUUID()}`, status: 'captured' }
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    this.applyScenario('refund', input.mockScenario)
    return { providerReference: `mock_refund_${randomUUID()}`, status: 'completed' }
  }

  async createMerchantPayout(input: MerchantPayoutInput): Promise<MerchantPayoutResult> {
    this.applyScenario('createMerchantPayout', input.mockScenario)
    return { providerReference: `mock_payout_${randomUUID()}`, status: 'pending' }
  }

  async verifyWebhook(input: WebhookVerificationInput): Promise<WebhookVerificationResult> {
    // Mock signature scheme: valid iff the header equals "mock-signature"
    // -- deliberately trivial, only used by tests exercising the webhook
    // framework's plumbing (dedup, audit logging), never a real provider.
    let payload: unknown
    try {
      payload = JSON.parse(input.rawBody)
    } catch {
      return { valid: false, providerEventId: null, payload: null }
    }
    const valid = input.headers['x-mock-signature'] === 'mock-signature'
    const providerEventId =
      valid && payload && typeof payload === 'object' && 'event_id' in payload
        ? String((payload as Record<string, unknown>).event_id)
        : null
    return { valid, providerEventId, payload }
  }

  async healthCheck(): Promise<HealthCheckResult> {
    return { healthy: true, provider: this.name }
  }

  /** Throws for the scenarios that represent a provider-level failure rather than a result value. */
  private applyScenario(operation: string, scenario: MockScenario | undefined): void {
    if (scenario === 'timeout') throw new ProviderTimeoutError(this.name, operation)
    if (scenario === 'retryable_failure') throw new RetryableProviderError(this.name, operation)
    if (scenario === 'terminal_failure') throw new TerminalProviderError(this.name, operation)
  }
}
