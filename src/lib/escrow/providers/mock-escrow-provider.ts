import { randomUUID } from 'crypto'
import type {
  EscrowProvider,
  EscrowProviderCapabilities,
  EscrowCreateInput,
  EscrowCreateResult,
  EscrowFundInput,
  EscrowFundResult,
  EscrowReleaseInput,
  EscrowReleaseResult,
  EscrowRefundInput,
  EscrowRefundResult,
  EscrowWebhookVerificationInput,
  EscrowWebhookVerificationResult,
  EscrowHealthCheckResult,
  EscrowMockScenario,
} from '../provider'
import { EscrowProviderTimeoutError, EscrowRetryableProviderError, EscrowTerminalProviderError } from '../provider-errors'

/**
 * Fully functional but entirely simulated -- no network call, no real
 * money, exactly mirroring MockProvider
 * (src/lib/payments/providers/mock-provider.ts). Every reference is
 * "mock_escrow_"-prefixed so it's obvious in logs/data that nothing real
 * happened. Deterministic: a scenario is only ever selected explicitly
 * via input.mockScenario, never randomly.
 */
export class MockEscrowProvider implements EscrowProvider {
  readonly name = 'mock'
  readonly capabilities: EscrowProviderCapabilities = {
    supportsPartialRefund: true,
    supportsManualFunding: true,
    requiresWebhookConfirmation: false,
  }

  async createEscrowTransaction(input: EscrowCreateInput): Promise<EscrowCreateResult> {
    this.applyScenario('createEscrowTransaction', input.mockScenario)
    if (input.mockScenario === 'duplicate') {
      return { providerReference: 'mock_escrow_duplicate', status: 'pending' }
    }
    return { providerReference: `mock_escrow_${randomUUID()}`, status: 'pending' }
  }

  async fundEscrowTransaction(input: EscrowFundInput): Promise<EscrowFundResult> {
    this.applyScenario('fundEscrowTransaction', input.mockScenario)
    if (input.mockScenario === 'declined') {
      return { providerReference: input.providerReference, status: 'failed', failureReason: 'mock funding declined' }
    }
    return { providerReference: input.providerReference, status: 'funded' }
  }

  async releaseEscrowTransaction(input: EscrowReleaseInput): Promise<EscrowReleaseResult> {
    this.applyScenario('releaseEscrowTransaction', input.mockScenario)
    if (input.mockScenario === 'declined') {
      return { providerReference: input.providerReference, status: 'failed', failureReason: 'mock release declined' }
    }
    return { providerReference: input.providerReference, status: 'released' }
  }

  async refundEscrowTransaction(input: EscrowRefundInput): Promise<EscrowRefundResult> {
    this.applyScenario('refundEscrowTransaction', input.mockScenario)
    if (input.mockScenario === 'declined') {
      return { providerReference: input.providerReference, status: 'failed', failureReason: 'mock refund declined' }
    }
    return { providerReference: input.providerReference, status: 'refunded' }
  }

  async verifyWebhook(input: EscrowWebhookVerificationInput): Promise<EscrowWebhookVerificationResult> {
    // Same trivial mock signature scheme as MockProvider.verifyWebhook --
    // valid iff the header equals "mock-signature". Only exercises the
    // webhook framework's own plumbing (dedup, audit logging).
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

  async healthCheck(): Promise<EscrowHealthCheckResult> {
    return { healthy: true, provider: this.name }
  }

  private applyScenario(operation: string, scenario: EscrowMockScenario | undefined): void {
    if (scenario === 'timeout') throw new EscrowProviderTimeoutError(this.name, operation)
    if (scenario === 'retryable_failure') throw new EscrowRetryableProviderError(this.name, operation)
    if (scenario === 'terminal_failure') throw new EscrowTerminalProviderError(this.name, operation)
  }
}
