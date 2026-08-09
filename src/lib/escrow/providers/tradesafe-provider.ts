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
} from '../provider'
import { EscrowNotImplementedError } from '../provider'

/**
 * TradeSafe is a PROPOSED escrow provider only -- there is no live
 * integration. This class exists solely so the registry has a second,
 * named key to demonstrate the interface is provider-neutral; every
 * method throws EscrowNotImplementedError, exactly mirroring
 * PeachPaymentsProvider's own stub shape
 * (src/lib/payments/providers/peach-provider.ts). Nothing in this
 * codebase ever calls TradeSafe, makes a TradeSafe API request, or
 * claims TradeSafe protection anywhere user-facing. See
 * docs/ESCROW_ARCHITECTURE.md.
 */
export class UnsupportedTradeSafeProvider implements EscrowProvider {
  readonly name = 'tradesafe'
  readonly capabilities: EscrowProviderCapabilities = {
    supportsPartialRefund: false,
    supportsManualFunding: false,
    requiresWebhookConfirmation: true,
  }

  async createEscrowTransaction(_input: EscrowCreateInput): Promise<EscrowCreateResult> {
    throw new EscrowNotImplementedError(this.name, 'createEscrowTransaction')
  }

  async fundEscrowTransaction(_input: EscrowFundInput): Promise<EscrowFundResult> {
    throw new EscrowNotImplementedError(this.name, 'fundEscrowTransaction')
  }

  async releaseEscrowTransaction(_input: EscrowReleaseInput): Promise<EscrowReleaseResult> {
    throw new EscrowNotImplementedError(this.name, 'releaseEscrowTransaction')
  }

  async refundEscrowTransaction(_input: EscrowRefundInput): Promise<EscrowRefundResult> {
    throw new EscrowNotImplementedError(this.name, 'refundEscrowTransaction')
  }

  async verifyWebhook(_input: EscrowWebhookVerificationInput): Promise<EscrowWebhookVerificationResult> {
    throw new EscrowNotImplementedError(this.name, 'verifyWebhook')
  }

  async healthCheck(): Promise<EscrowHealthCheckResult> {
    return { healthy: false, provider: this.name, detail: 'TradeSafe is not yet integrated' }
  }
}
