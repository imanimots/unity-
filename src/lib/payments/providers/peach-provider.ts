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
import { loadOrchestrationConfig, OrchestrationConfigurationError, type OrchestrationConfig } from './orchestration/config'
import { OrchestrationClient } from './orchestration/client'
import { parseCapturePaymentResponse, parseCancelPaymentResponse } from './orchestration/response-parsers'

/**
 * Money-moving methods are partially wired to Peach Orchestration as of
 * P5C (see the P5B.2-R phase report for the product-selection evidence:
 * a genuinely distinct generation from the classic Checkout V2/Payments
 * API/Card-backoffice-API scaffolding under ./peach/, which remains
 * present but unreferenced by any of these methods -- left in place for
 * a later cleanup phase to remove, not deleted here).
 *
 * `captureDeposit()`/`releaseDeposit()` are wired for real: both act on
 * an *already-created* payment (one that already reached
 * `requires_capture` via a completed Hosted Checkout session), so
 * Orchestration's synchronous capture/cancel response is genuinely
 * authoritative -- no pending state is possible at this point.
 *
 * `chargeRental()`/`authorizeDeposit()` remain stubs -- NOT an
 * oversight, a genuine architecture gap discovered while implementing
 * this phase: creating a Hosted Checkout session is itself asynchronous
 * (the shopper hasn't paid yet at creation time), but `ChargeResult`/
 * `DepositResult` only support synchronous `'captured'|'failed'`/
 * `'authorised'|...|'failed'` outcomes with no pending value. Returning
 * from either method today would force a false signal in one direction
 * or the other. See each method's own comment for the full reasoning,
 * and the P5C phase report for the resolution options this raises.
 * The request-builder primitives for both
 * (`buildOrdinaryPaymentRequest`/`buildDepositAuthorisationRequest` in
 * ./orchestration/request-builders.ts) are fully built and tested,
 * ready for whichever resolution is chosen.
 *
 * `createPaymentIntent()` remains a stub: zero real call sites in the
 * orchestrator, and its input shape has no return-URL concept.
 * `refund()`/`createMerchantPayout()`/`createAffiliatePayout()` remain
 * stubs -- explicitly P5E/deferred. `verifyWebhook()` is untouched --
 * explicitly P5D scope; it continues to use the classic signature
 * scheme and classic config, since Orchestration's own webhook
 * authentication model (custom HTTP headers, no confirmed HMAC
 * canonicalization) was not established precisely enough this phase to
 * safely wire a real verifier.
 */
export class PeachPaymentsProvider implements PaymentProvider {
  readonly name = 'peach'

  private requireOrchestrationConfig(): OrchestrationConfig {
    const config = loadOrchestrationConfig()
    if (!config) {
      throw new OrchestrationConfigurationError('Peach Orchestration is not configured (PEACH_ORCHESTRATION_ENVIRONMENT/API_BASE_URL/API_KEY)')
    }
    return config
  }

  private orchestrationClient(): OrchestrationClient {
    return new OrchestrationClient(this.requireOrchestrationConfig())
  }

  async createPaymentIntent(_input: PaymentIntentInput): Promise<PaymentIntentResult> {
    void _input
    throw new NotImplementedError(this.name, 'createPaymentIntent')
  }

  /**
   * NOT WIRED THIS PHASE -- a genuine, discovered architecture gap, not
   * an oversight. Creating a Hosted Checkout session (`payment_link:
   * true`, `confirm: false`) is inherently asynchronous: the response to
   * `POST /payments` reflects that a session was created (e.g.
   * `requires_confirmation`), not whether the shopper has authorised
   * anything -- that only becomes known later, via webhook (P5D) or an
   * explicit `GET /payments/{id}` sync. The existing `DepositResult`
   * type (`status: 'authorised' | 'captured' | 'released' | 'failed'`)
   * has no pending/in-progress value, so returning from this method
   * would force a choice between two false signals: claiming
   * 'authorised' before the shopper has done anything, or claiming
   * 'failed' for a checkout session that's actually still open and
   * valid. Neither is acceptable, and this phase's own scope forbids
   * both widening this interface and implementing the P5D webhook layer
   * that would resolve it properly. buildDepositAuthorisationRequest()
   * (request-builders.ts) is fully built and tested and ready for
   * whichever resolution is chosen.
   */
  async authorizeDeposit(_input: DepositInput): Promise<DepositResult> {
    void _input
    throw new NotImplementedError(this.name, 'authorizeDeposit (Hosted Checkout session creation is asynchronous; see class-level comment)')
  }

  async captureDeposit(input: DepositInput): Promise<DepositResult> {
    if (!input.providerReference) {
      throw new NotImplementedError(this.name, 'captureDeposit (missing providerReference)')
    }
    const client = this.orchestrationClient()
    const raw = await client.post(`/payments/${encodeURIComponent(input.providerReference)}/capture`, {}, 'captureDeposit')
    const parsed = parseCapturePaymentResponse(raw)
    const status = parsed.status === 'succeeded' || parsed.status === 'partially_captured' ? 'captured' : 'failed'
    return { providerReference: parsed.payment_id, status }
  }

  async releaseDeposit(input: DepositInput): Promise<DepositResult> {
    if (!input.providerReference) {
      throw new NotImplementedError(this.name, 'releaseDeposit (missing providerReference)')
    }
    const client = this.orchestrationClient()
    const raw = await client.post(`/payments/${encodeURIComponent(input.providerReference)}/cancel`, {}, 'releaseDeposit')
    const parsed = parseCancelPaymentResponse(raw)
    const status = parsed.status === 'cancelled' ? 'released' : 'failed'
    return { providerReference: parsed.payment_id, status }
  }

  /**
   * NOT WIRED THIS PHASE -- same reason as authorizeDeposit() above:
   * session creation is asynchronous, and `ChargeResult`'s
   * `'captured' | 'failed'` shape has no pending state to return
   * honestly. buildOrdinaryPaymentRequest() is fully built and tested.
   */
  async chargeRental(_input: ChargeInput): Promise<ChargeResult> {
    void _input
    throw new NotImplementedError(this.name, 'chargeRental (Hosted Checkout session creation is asynchronous; see class-level comment)')
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

  /**
   * Reports Orchestration config status as the primary `healthy` signal
   * -- it's the active path for the two money-moving operations that
   * are actually wired (captureDeposit/releaseDeposit) as of P5C.
   * Classic config status is included in `detail` only, for visibility,
   * since `verifyWebhook()` still depends on it and remains untouched.
   * No network call either way -- shape validation only, unchanged
   * contract from before this phase.
   */
  async healthCheck(): Promise<HealthCheckResult> {
    let orchestrationDetail: string
    let orchestrationHealthy: boolean
    try {
      const config = loadOrchestrationConfig()
      orchestrationHealthy = config !== null
      orchestrationDetail = config ? `orchestration: environment=${config.environment}` : 'orchestration: not configured'
    } catch (err) {
      orchestrationHealthy = false
      orchestrationDetail = `orchestration: ${err instanceof OrchestrationConfigurationError ? err.message : err instanceof Error ? err.message : String(err)}`
    }

    let classicDetail: string
    try {
      const classicStatus = describePeachConfigStatus(loadPeachConfig())
      classicDetail = `classic (verifyWebhook only): ${classicStatus.detail}`
    } catch (err) {
      classicDetail = `classic (verifyWebhook only): ${err instanceof PeachConfigurationError ? err.message : err instanceof Error ? err.message : String(err)}`
    }

    return { healthy: orchestrationHealthy, provider: this.name, detail: `${orchestrationDetail}; ${classicDetail}` }
  }
}
