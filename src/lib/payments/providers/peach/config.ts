/**
 * Peach configuration -- environment variables only, never a secret in
 * code or in documentation (docs/PEACH_INTEGRATION.md lists variable
 * *names* only). Reading env vars and validating their shape is not a
 * network call, so this is safe to build for real this phase (unlike any
 * money-moving method).
 *
 * Peach turned out to span four separate credential domains, not one --
 * discovered while mapping which product covers which Unity operation
 * (see docs/PEACH_INTEGRATION.md "Architecture review"):
 *   - Payments API v2 (basic auth: entityId/userId/password) -- rental
 *     charge (DB) and its refund (RF). Covers every Peach payment method,
 *     not just cards.
 *   - Checkout V2 (JWT bearer + HMAC webhook secret) -- hosted/embedded
 *     card entry; can *create* a deposit authorization (paymentType PA)
 *     with a low PCI burden (SAQ-A).
 *   - Card/backoffice API (a *different* bearer token than Checkout's,
 *     confirmed in docs/card-manage-payments -- "use a Server-to-Server,
 *     Mobile SDK, recurring, or COPYandPAY bearer token, not a Checkout
 *     bearer token") -- capture (CP) or reverse (RV) a PA created by any
 *     product, including one Checkout created.
 *   - Payouts API (its own JWT) -- merchant payout disbursement.
 * All four are optional independently: a deployment could enable rental
 * charges (Payments API only) before deposits (Checkout + card API) or
 * payouts are ready. `loadPeachConfig()` reflects that -- each block is
 * `null` if its variables are absent, not a hard failure.
 */

export type PeachEnvironment = 'sandbox' | 'production'

export interface PeachPaymentsApiConfig {
  baseUrl: string
  entityId: string
  userId: string
  password: string
}

export interface PeachCheckoutConfig {
  baseUrl: string
  entityId: string
  webhookSigningSecret: string
  /** The exact URL registered with Peach for this webhook -- part of the signed string (docs/checkout-webhooks). Must match byte-for-byte. */
  webhookUrl: string
}

export interface PeachCardApiConfig {
  baseUrl: string
  backofficeBearerToken: string
  webhookDecryptionKey: string
}

export interface PeachPayoutsConfig {
  baseUrl: string
  bearerToken: string
}

export interface PeachConfig {
  environment: PeachEnvironment
  paymentsApi: PeachPaymentsApiConfig | null
  checkout: PeachCheckoutConfig | null
  cardApi: PeachCardApiConfig | null
  payouts: PeachPayoutsConfig | null
}

const SANDBOX_URLS = {
  paymentsApi: 'https://testapi-v2.peachpayments.com',
  checkout: 'https://testsecure.peachpayments.com',
  cardApi: 'https://sandbox-card.peachpayments.com',
  payouts: 'https://sandbox-payouts.peachpayments.com/api',
}

// Production host for the card/backoffice API is NOT directly confirmed in
// the fetched documentation (only the sandbox host, sandbox-card.*, was
// given explicitly) -- inferred by dropping the "sandbox-" prefix, the
// same pattern every other confirmed Peach host follows. Flagged here
// deliberately rather than asserted as fact; verify against the Dashboard
// or Peach support before any production cutover. See
// docs/PEACH_INTEGRATION.md "Known limitations".
const PRODUCTION_URLS = {
  paymentsApi: 'https://api-v2.peachpayments.com',
  checkout: 'https://secure.peachpayments.com',
  cardApi: 'https://card.peachpayments.com',
  payouts: 'https://payouts.peachpayments.com/api',
}

export class PeachConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PeachConfigurationError'
  }
}

function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]
  return value && value.trim() ? value.trim() : undefined
}

/**
 * Reads every Peach env var, returning whichever credential blocks are
 * fully present -- never throws for a partially-configured deployment.
 * Throws only if `PEACH_ENVIRONMENT` itself is missing/invalid, since
 * every URL choice depends on it.
 */
export function loadPeachConfig(env: NodeJS.ProcessEnv = process.env): PeachConfig {
  const environment = readEnv(env, 'PEACH_ENVIRONMENT')
  if (environment !== 'sandbox' && environment !== 'production') {
    throw new PeachConfigurationError('PEACH_ENVIRONMENT must be "sandbox" or "production"')
  }
  const urls = environment === 'sandbox' ? SANDBOX_URLS : PRODUCTION_URLS

  const paymentsApiEntityId = readEnv(env, 'PEACH_PAYMENTS_API_ENTITY_ID')
  const paymentsApiUserId = readEnv(env, 'PEACH_PAYMENTS_API_USER_ID')
  const paymentsApiPassword = readEnv(env, 'PEACH_PAYMENTS_API_PASSWORD')
  const paymentsApi =
    paymentsApiEntityId && paymentsApiUserId && paymentsApiPassword
      ? { baseUrl: urls.paymentsApi, entityId: paymentsApiEntityId, userId: paymentsApiUserId, password: paymentsApiPassword }
      : null

  const checkoutEntityId = readEnv(env, 'PEACH_CHECKOUT_ENTITY_ID')
  const checkoutWebhookSecret = readEnv(env, 'PEACH_CHECKOUT_WEBHOOK_SIGNING_SECRET')
  const checkoutWebhookUrl = readEnv(env, 'PEACH_CHECKOUT_WEBHOOK_URL')
  const checkout =
    checkoutEntityId && checkoutWebhookSecret && checkoutWebhookUrl
      ? { baseUrl: urls.checkout, entityId: checkoutEntityId, webhookSigningSecret: checkoutWebhookSecret, webhookUrl: checkoutWebhookUrl }
      : null

  const cardApiBearerToken = readEnv(env, 'PEACH_CARD_API_BACKOFFICE_BEARER_TOKEN')
  const cardApiWebhookKey = readEnv(env, 'PEACH_CARD_API_WEBHOOK_DECRYPTION_KEY')
  const cardApi =
    cardApiBearerToken && cardApiWebhookKey ? { baseUrl: urls.cardApi, backofficeBearerToken: cardApiBearerToken, webhookDecryptionKey: cardApiWebhookKey } : null

  const payoutsBearerToken = readEnv(env, 'PEACH_PAYOUTS_API_BEARER_TOKEN')
  const payouts = payoutsBearerToken ? { baseUrl: urls.payouts, bearerToken: payoutsBearerToken } : null

  return { environment, paymentsApi, checkout, cardApi, payouts }
}

export interface PeachConfigStatus {
  healthy: boolean
  detail: string
}

/**
 * No network call -- "healthy" here means "well-formed enough to attempt
 * a call", not "Peach is reachable". At least one credential block must
 * be configured; which ones determines which orchestrator operations this
 * deployment can actually perform (surfaced in `detail`, not enforced
 * here -- an individual money-moving method decides for itself whether
 * its own required block is present).
 */
export function describePeachConfigStatus(config: PeachConfig): PeachConfigStatus {
  const configured: string[] = []
  const missing: string[] = []
  ;(['paymentsApi', 'checkout', 'cardApi', 'payouts'] as const).forEach((key) => {
    if (config[key]) configured.push(key)
    else missing.push(key)
  })

  if (configured.length === 0) {
    return { healthy: false, detail: `No Peach credential blocks configured (environment: ${config.environment})` }
  }
  return {
    healthy: true,
    detail: `environment=${config.environment}; configured=[${configured.join(', ')}]; not configured=[${missing.join(', ')}]`,
  }
}
