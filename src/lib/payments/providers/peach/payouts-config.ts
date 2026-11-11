import { PeachConfigurationError } from './config'

/**
 * E32: the real current Peach Payouts auth model (OAuth client-
 * credentials), replacing the confirmed-stale, confirmed-dead-code
 * PEACH_PAYOUTS_API_BEARER_TOKEN from the classic peach/config.ts block
 * (never deleted here -- that remains a separate cleanup decision, see
 * docs/PEACH_INTEGRATION.md §0). Reuses PEACH_ENVIRONMENT (the one
 * canonical sandbox/production selector already governing every other
 * Peach credential block) rather than adding a second, potentially
 * contradictory environment toggle -- confirmed live this phase that
 * the Payouts host pair is the same host the classic (dead) bearer-token
 * block already pointed at.
 *
 * All-or-nothing once PEACH_PAYOUTS_CLIENT_ID is set, mirroring the
 * Orchestration config's own "all-or-nothing single credential set"
 * shape (an OAuth client-credentials triple is structurally one unit,
 * not four independent optional blocks like the classic peach/
 * config.ts).
 */

const SANDBOX_BASE_URL = 'https://sandbox-payouts.peachpayments.com/api'
const PRODUCTION_BASE_URL = 'https://payouts.peachpayments.com/api'

export interface PeachPayoutsConfig {
  environment: 'sandbox' | 'production'
  baseUrl: string
  clientId: string
  clientSecret: string
  merchantId: string
  webhookSigningSecret: string | null
}

function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]
  return value && value.trim() ? value.trim() : undefined
}

/**
 * Returns null when nothing is configured at all. Throws if the client
 * credential triple is partially set, or if PEACH_ENVIRONMENT is absent/
 * invalid while a client id is present (the host can't be chosen
 * without it). Webhook signing secret is independently optional --
 * verification can be (and should be) configured separately, and its
 * absence must never silently allow an unverified webhook through (the
 * route layer, not this loader, enforces that).
 */
export function loadPeachPayoutsConfig(env: NodeJS.ProcessEnv = process.env): PeachPayoutsConfig | null {
  const clientId = readEnv(env, 'PEACH_PAYOUTS_CLIENT_ID')
  const clientSecret = readEnv(env, 'PEACH_PAYOUTS_CLIENT_SECRET')
  const merchantId = readEnv(env, 'PEACH_PAYOUTS_MERCHANT_ID')
  const webhookSigningSecret = readEnv(env, 'PEACH_PAYOUTS_WEBHOOK_SIGNING_SECRET') ?? null

  if (!clientId && !clientSecret && !merchantId) return null

  if (!clientId || !clientSecret || !merchantId) {
    throw new PeachConfigurationError('PEACH_PAYOUTS_CLIENT_ID, PEACH_PAYOUTS_CLIENT_SECRET, and PEACH_PAYOUTS_MERCHANT_ID must all be set together')
  }

  const environment = readEnv(env, 'PEACH_ENVIRONMENT')
  if (environment !== 'sandbox' && environment !== 'production') {
    throw new PeachConfigurationError('PEACH_ENVIRONMENT must be "sandbox" or "production" when Peach Payouts is configured')
  }

  return {
    environment,
    baseUrl: environment === 'sandbox' ? SANDBOX_BASE_URL : PRODUCTION_BASE_URL,
    clientId,
    clientSecret,
    merchantId,
    webhookSigningSecret,
  }
}
