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
  PaymentCapability,
} from '../provider'
import { NotImplementedError } from '../provider'
import { loadPeachConfig, describePeachConfigStatus, PeachConfigurationError } from './peach/config'
import { verifyCheckoutSignature, decryptOppwaWebhook } from './peach/signature'
import { normalizeCheckoutWebhookPayload, normalizeOppwaWebhookPayload, normalizePayoutWebhookPayload } from './peach/event-normalizer'
import { loadOrchestrationConfig, OrchestrationConfigurationError, type OrchestrationConfig } from './orchestration/config'
import { OrchestrationClient } from './orchestration/client'
import { buildOrdinaryPaymentRequest, buildDepositAuthorisationRequest } from './orchestration/request-builders'
import { parseCreateHostedCheckoutPaymentResponse, parseCapturePaymentResponse, parseCancelPaymentResponse, parseGetPaymentResponse, extractRedirectUrl } from './orchestration/response-parsers'
import type { GetPaymentResponse } from './orchestration/types'
import { orchestrationReturnUrl } from '@/app/api/payments/checkout-return/route'
import { loadPeachPayoutsConfig, type PeachPayoutsConfig } from './peach/payouts-config'
import { PeachPayoutsClient } from './peach/banv-client'

/**
 * Money-moving methods are wired to Peach Orchestration as of P5C.1 (see
 * the P5B.2-R phase report for the product-selection evidence: a
 * genuinely distinct generation from the classic Checkout V2/Payments
 * API/Card-backoffice-API scaffolding under ./peach/, which remains
 * present but unreferenced by any of these methods -- left in place for
 * a later cleanup phase to remove, not deleted here).
 *
 * `chargeRental()`/`authorizeDeposit()` create a Hosted Checkout session
 * and return `requires_action` (never a false `'captured'`/`'authorised'`)
 * -- P5C found that session creation is inherently asynchronous (the
 * shopper hasn't paid yet), and P5C.1 closes that gap by widening
 * `ChargeResult`/`DepositResult` into genuine discriminated unions
 * (../provider.ts) rather than forcing either method to lie. Every
 * orchestrator caller was updated to treat `requires_action` as "leave
 * `payments.status` at `pending`, persist the provider reference, return
 * the redirect URL" -- never a financial state transition. Resolving
 * `requires_action` to a final `captured`/`authorised`/`failed` state
 * remains P5D's job (webhook reconciliation), not this method's.
 *
 * `captureDeposit()`/`releaseDeposit()` act on an *already-created*
 * payment (one that already reached `requires_capture` via a completed
 * Hosted Checkout session), so Orchestration's synchronous capture/
 * cancel response is genuinely authoritative -- no pending state is
 * possible at this point, unchanged from P5C.
 *
 * `createPaymentIntent()` remains a stub: zero real call sites in the
 * orchestrator. `refund()` remains a stub -- E31 found the refund
 * contract cannot be confirmed against current official docs, still
 * binding. `createMerchantPayout()`/`createAffiliatePayout()` are real
 * as of E33, wired to Peach Payouts' create-payout call -- see that
 * method's own comment. `verifyWebhook()` is untouched for
 * Checkout/OPPWA -- Payouts webhooks go through their own dedicated,
 * signed route instead (E33).
 */
export class PeachPaymentsProvider implements PaymentProvider {
  readonly name = 'peach'

  /**
   * E30/E33: self-reported, matching this class's own method bodies
   * exactly -- chargeRental/authorizeDeposit/captureDeposit/
   * releaseDeposit are wired to real Orchestration calls above;
   * createMerchantPayout/createAffiliatePayout are wired to the real
   * Peach Payouts create-payout call (E33); refund remains a
   * NotImplementedError stub (E31 remains binding -- the refund
   * contract was never confirmed against current official docs);
   * verifyWebhook is fully implemented for Checkout/OPPWA. Update this
   * set in the same change that wires up (or removes) any of those
   * methods -- never separately. Reporting `merchant_payout`/
   * `affiliate_payout` here means "a real implementation exists", NOT
   * "production execution is enabled" -- that is the separate,
   * independently-gated PEACH_PAYOUTS_EXECUTION_ENABLED check in
   * src/lib/payments/payout-execution/gate.ts, enforced by every
   * orchestrator call site, never by this capability flag alone.
   */
  private static readonly SUPPORTED_CAPABILITIES: ReadonlySet<PaymentCapability> = new Set<PaymentCapability>([
    'charge_rental',
    'authorize_deposit',
    'capture_deposit',
    'release_deposit',
    'merchant_payout',
    'affiliate_payout',
    'webhook_verification',
  ])

  supportsCapability(capability: PaymentCapability): boolean {
    return PeachPaymentsProvider.SUPPORTED_CAPABILITIES.has(capability)
  }

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
   * Creates a manual-capture (`capture_method: 'manual'`) Hosted
   * Checkout session. Always returns `requires_action` on success --
   * never `'authorised'`, which would falsely claim the shopper has
   * already acted. `payment_link_config`'s allowed-method restriction is
   * deliberately left unset (see request-builders.ts's own comment:
   * which Peach payment methods actually support preauthorisation was
   * never confirmed by any fetch performed across this project's
   * research, so none is guessed into the request).
   */
  async authorizeDeposit(input: DepositInput): Promise<DepositResult> {
    const client = this.orchestrationClient()
    const request = buildDepositAuthorisationRequest({
      amount: input.amount.toFixed(2),
      currency: input.currency,
      returnUrl: orchestrationReturnUrl(),
      metadata: { unity_payment_id: input.paymentId },
    })
    const raw = await client.post('/payments', request, 'authorizeDeposit')
    const parsed = parseCreateHostedCheckoutPaymentResponse(raw)
    const redirectUrl = extractRedirectUrl(raw as Record<string, unknown>)
    return { status: 'requires_action', providerReference: parsed.payment_id, redirectUrl }
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
   * Creates an automatic-capture Hosted Checkout session for the
   * ordinary rental/order/barter-cash-adjustment/RTB-instalment charge.
   * Always returns `requires_action` on success, never `'captured'` --
   * see the class-level comment.
   */
  async chargeRental(input: ChargeInput): Promise<ChargeResult> {
    const client = this.orchestrationClient()
    const request = buildOrdinaryPaymentRequest({
      amount: input.amount.toFixed(2),
      currency: input.currency,
      returnUrl: orchestrationReturnUrl(),
      metadata: { unity_payment_id: input.paymentId },
    })
    const raw = await client.post('/payments', request, 'chargeRental')
    const parsed = parseCreateHostedCheckoutPaymentResponse(raw)
    const redirectUrl = extractRedirectUrl(raw as Record<string, unknown>)
    return { status: 'requires_action', providerReference: parsed.payment_id, redirectUrl }
  }

  /**
   * P5D-B: server-side authoritative retrieval, `GET
   * /payments/{payment_id}?force_sync=true`. Not part of the generic
   * PaymentProvider interface (no other provider has an equivalent
   * concept, and forcing one onto MockProvider/the shared contract
   * would be exactly the kind of Orchestration-specific leakage P5D-B
   * is required to avoid) -- called directly by
   * reconcile-orchestration-payment.ts's force-sync caller once wired.
   * Uses the existing OrchestrationClient.get() path and the
   * already-tested parseGetPaymentResponse() parser -- neither needed
   * to change.
   */
  async getPayment(paymentId: string, options: { forceSync: boolean } = { forceSync: true }): Promise<GetPaymentResponse> {
    const client = this.orchestrationClient()
    const query = options.forceSync ? '?force_sync=true' : ''
    const raw = await client.get(`/payments/${encodeURIComponent(paymentId)}${query}`, 'getPayment')
    return parseGetPaymentResponse(raw)
  }

  async refund(_input: RefundInput): Promise<RefundResult> {
    void _input
    throw new NotImplementedError(this.name, 'refund')
  }

  private requirePeachPayoutsConfig(): PeachPayoutsConfig {
    const config = loadPeachPayoutsConfig()
    if (!config) {
      throw new PeachConfigurationError('Peach Payouts is not configured (PEACH_PAYOUTS_CLIENT_ID/CLIENT_SECRET/MERCHANT_ID)')
    }
    return config
  }

  private payoutsClient(): PeachPayoutsClient {
    return new PeachPayoutsClient(this.requirePeachPayoutsConfig())
  }

  /**
   * E33: every field here is already server-resolved by the
   * orchestrator before this is ever called (phase brief §33 -- this
   * method never fetches banking/identity data itself). Submits
   * exactly one payout per call; Peach's create response can already
   * carry a final-ish status (confirmed live, the same 6-value enum
   * the webhook uses), which is returned as-is -- this method never
   * upgrades a non-'successful' status to anything resembling
   * finality itself.
   */
  async createMerchantPayout(input: MerchantPayoutInput): Promise<MerchantPayoutResult> {
    const client = this.payoutsClient()
    const result = await client.createPayout({
      payoutId: input.payoutId,
      reference: input.reference,
      amountMinorUnits: input.amountMinorUnits,
      currency: input.currency,
      bankName: input.bankName,
      branchCode: input.branchCode,
      accountNumber: input.accountNumber,
      accountHolder: input.accountHolder,
    })
    return { providerPayoutId: result.payoutId, providerRequestId: result.payoutRequestId, status: result.status, resultCode: result.resultCode }
  }

  async createAffiliatePayout(input: AffiliatePayoutInput): Promise<AffiliatePayoutResult> {
    const client = this.payoutsClient()
    const result = await client.createPayout({
      payoutId: input.payoutId,
      reference: input.reference,
      amountMinorUnits: input.amountMinorUnits,
      currency: input.currency,
      bankName: input.bankName,
      branchCode: input.branchCode,
      accountNumber: input.accountNumber,
      accountHolder: input.accountHolder,
    })
    return { providerPayoutId: result.payoutId, providerRequestId: result.payoutRequestId, status: result.status, resultCode: result.resultCode }
  }

  /**
   * Dispatches on which headers are actually present, since Peach has
   * three distinct webhook schemes with no shared marker field (see
   * docs/PEACH_INTEGRATION.md "Webhook mapping"): Checkout/Payment-Links
   * (HMAC, `x-webhook-signature`), OPPWA/card (encrypted,
   * `x-initialization-vector`), and Payouts (Svix/Standard Webhooks,
   * `webhook-id`/`webhook-timestamp`/`webhook-signature` -- confirmed
   * live, E31/E32; see providers/peach/payouts-webhook-signature.ts).
   * The Payouts case here is STILL deliberately treated as unverifiable
   * -- `invalid` with no payload, same as a failed signature check --
   * not because the scheme is undocumented (it now is), but because a
   * real Peach Payouts webhook is never meant to reach this GENERIC
   * dispatcher at all: it has its own dedicated, signed route
   * (src/app/api/payments/webhooks/peach-payouts/route.ts, E33), which
   * uses verifyPayoutsWebhookSignature() directly against the raw body
   * before this class is ever involved. If a delivery somehow reaches
   * this generic path instead, failing closed is correct regardless.
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
