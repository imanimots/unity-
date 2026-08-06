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
  AffiliatePayoutInput,
  AffiliatePayoutResult,
  WebhookVerificationInput,
  WebhookVerificationResult,
  HealthCheckResult,
} from '../provider'
import { NotImplementedError } from '../provider'
import { loadPeachConfig, describePeachConfigStatus, PeachConfigurationError } from './peach/config'
import { verifyCheckoutSignature, decryptOppwaWebhook } from './peach/signature'
import { normalizeCheckoutWebhookPayload, normalizeOppwaWebhookPayload, normalizePayoutWebhookPayload } from './peach/event-normalizer'

/**
 * Every money-moving method is still a stub (throws NotImplementedError)
 * -- Phase 2D (docs/PEACH_INTEGRATION.md) is discovery and compatibility
 * proof only, not a real integration. `healthCheck()` and `verifyWebhook()`
 * are the two exceptions: neither moves money and neither requires a live
 * network call (healthCheck inspects configuration only; verifyWebhook is
 * pure cryptography over whatever the caller already received), so both
 * are implemented for real. The request-builder / response-parser /
 * error-mapper modules under ./peach/ are also real and unit-tested, but
 * are not yet called from any method here -- wiring them into an actual
 * fetch() is Phase 2E work, once Phase 2D is reviewed and approved.
 */
export class PeachPaymentsProvider implements PaymentProvider {
  readonly name = 'peach'

  async createPaymentIntent(_input: PaymentIntentInput): Promise<PaymentIntentResult> {
    void _input
    throw new NotImplementedError(this.name, 'createPaymentIntent')
  }

  async authorizeDeposit(_input: DepositInput): Promise<DepositResult> {
    void _input
    throw new NotImplementedError(this.name, 'authorizeDeposit')
  }

  async captureDeposit(_input: DepositInput): Promise<DepositResult> {
    void _input
    throw new NotImplementedError(this.name, 'captureDeposit')
  }

  async releaseDeposit(_input: DepositInput): Promise<DepositResult> {
    void _input
    throw new NotImplementedError(this.name, 'releaseDeposit')
  }

  async chargeRental(_input: ChargeInput): Promise<ChargeResult> {
    void _input
    throw new NotImplementedError(this.name, 'chargeRental')
  }

  async refund(_input: RefundInput): Promise<RefundResult> {
    void _input
    throw new NotImplementedError(this.name, 'refund')
  }

  async createMerchantPayout(_input: MerchantPayoutInput): Promise<MerchantPayoutResult> {
    void _input
    throw new NotImplementedError(this.name, 'createMerchantPayout')
  }

  async createAffiliatePayout(_input: AffiliatePayoutInput): Promise<AffiliatePayoutResult> {
    void _input
    throw new NotImplementedError(this.name, 'createAffiliatePayout')
  }

  /**
   * Dispatches on which headers are actually present, since Peach has
   * three distinct webhook schemes with no shared marker field (see
   * docs/PEACH_INTEGRATION.md "Webhook mapping"): Checkout/Payment-Links
   * (HMAC, `x-webhook-signature`), OPPWA/card (encrypted,
   * `x-initialization-vector`), and Payouts (no documented signature
   * mechanism at all). The Payouts case is the one deliberately
   * conservative choice here: since Peach's docs never confirmed a
   * verification mechanism for it, this treats it as unverifiable rather
   * than assuming it's safe to trust unsigned -- `invalid` with no
   * payload, same as a failed signature check. That must be revisited
   * (confirmed with Peach support or in a sandbox trace) before Phase 2E
   * processes a real payout webhook.
   */
  async verifyWebhook(input: WebhookVerificationInput): Promise<WebhookVerificationResult> {
    const config = loadPeachConfig()

    if (input.headers['x-webhook-signature']) {
      if (!config.checkout) return { valid: false, providerEventId: null, payload: null }
      const verification = verifyCheckoutSignature({
        headers: input.headers,
        rawBody: input.rawBody,
        webhookUrl: config.checkout.webhookUrl,
        secret: config.checkout.webhookSigningSecret,
      })
      if (!verification.valid) return { valid: false, providerEventId: null, payload: null }
      let payload: unknown
      try {
        payload = JSON.parse(input.rawBody)
      } catch {
        return { valid: false, providerEventId: null, payload: null }
      }
      const normalized = normalizeCheckoutWebhookPayload(payload)
      return { valid: true, providerEventId: normalized?.peachTransactionId ?? null, payload }
    }

    if (input.headers['x-initialization-vector']) {
      if (!config.cardApi) return { valid: false, providerEventId: null, payload: null }
      const decrypted = decryptOppwaWebhook({ headers: input.headers, rawBody: input.rawBody, keyHex: config.cardApi.webhookDecryptionKey })
      if (!decrypted.payload) return { valid: false, providerEventId: null, payload: null }
      const normalized = normalizeOppwaWebhookPayload(decrypted.payload)
      return { valid: true, providerEventId: normalized?.peachTransactionId ?? null, payload: decrypted.payload }
    }

    // Payouts webhook (no confirmed signature scheme) or an unrecognized
    // shape -- both treated the same conservative way, above.
    let unsignedPayload: unknown
    try {
      unsignedPayload = JSON.parse(input.rawBody)
    } catch {
      return { valid: false, providerEventId: null, payload: null }
    }
    void normalizePayoutWebhookPayload(unsignedPayload) // shape proven, not trusted -- see doc comment above
    return { valid: false, providerEventId: null, payload: null }
  }

  async healthCheck(): Promise<HealthCheckResult> {
    try {
      const config = loadPeachConfig()
      const status = describePeachConfigStatus(config)
      return { healthy: status.healthy, provider: this.name, detail: status.detail }
    } catch (err) {
      const detail = err instanceof PeachConfigurationError ? err.message : err instanceof Error ? err.message : String(err)
      return { healthy: false, provider: this.name, detail }
    }
  }
}
