/**
 * Peach Orchestration webhook authentication configuration (P5D-B).
 *
 * Deliberately a SEPARATE, smaller config module from ./config.ts
 * (which governs the outbound API client's `api-key` auth) -- webhook
 * verification is a different trust boundary with its own two secrets,
 * and mixing them would make it possible to accidentally satisfy one
 * concern with the other's credential. Neither secret here is ever the
 * same value as PEACH_ORCHESTRATION_API_KEY.
 *
 * Two layers (P5D-A.1's accepted design):
 *   Layer 1 -- PEACH_ORCHESTRATION_WEBHOOK_SECRET: a dedicated,
 *     high-entropy value configured on the Peach business profile via
 *     `outgoing_webhook_custom_http_headers`, sent back on every
 *     delivery in a custom header Unity checks for an exact
 *     constant-time match.
 *   Layer 2 -- PEACH_ORCHESTRATION_PAYMENT_RESPONSE_HASH_KEY: the
 *     `payment_response_hash_key` Peach returns once and Unity must
 *     store, used to verify HMAC-SHA512 over the raw request body
 *     (confirmed contract -- see webhook-auth.ts).
 *
 * This module never touches src/lib/env/validate.ts (a frozen,
 * pre-existing dirty path this phase must not modify) -- it is a wholly
 * separate, narrowly-scoped, fail-closed loader in the same "absent
 * config is not an error until actually used" style as
 * loadOrchestrationConfig()/loadPeachConfig(), so importing this module
 * never throws merely because the webhook path isn't configured yet in
 * an environment that doesn't need it (e.g. local dev, a non-payment
 * test run) -- only calling verifyOrchestrationWebhook() with it missing
 * does.
 */

export interface OrchestrationWebhookConfig {
  customSecretHeaderName: string
  customSecretValue: string
  paymentResponseHashKey: string
}

export class OrchestrationWebhookConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OrchestrationWebhookConfigurationError'
  }
}

/**
 * The one, explicit custom header name Unity checks for Layer 1 -- not
 * itself a secret, chosen in source per the phase brief ("a single
 * explicit header name chosen in source/config"), and the same name
 * that must be configured on the Peach business profile's
 * `outgoing_webhook_custom_http_headers`. Lower-cased: Next.js/Node
 * request headers are always read lower-cased.
 */
export const ORCHESTRATION_WEBHOOK_SECRET_HEADER = 'x-unity-webhook-secret'

/** Peach's own confirmed header name for the raw-body HMAC-SHA512 signature (P5D-A.1/P5D-M1.1). */
export const ORCHESTRATION_WEBHOOK_SIGNATURE_HEADER = 'x-webhook-signature-512'

function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]
  return value && value.trim() ? value.trim() : undefined
}

/**
 * Returns null (never throws) when neither webhook-auth env var is set
 * at all -- same "absent config is not an error, just unavailable"
 * convention as every other config loader in this codebase. Throws only
 * when PARTIALLY configured (one present, one missing) -- a
 * misconfiguration that should fail loud, not silently accept a
 * half-secured webhook path.
 */
export function loadOrchestrationWebhookConfig(env: NodeJS.ProcessEnv = process.env): OrchestrationWebhookConfig | null {
  const customSecretValue = readEnv(env, 'PEACH_ORCHESTRATION_WEBHOOK_SECRET')
  const paymentResponseHashKey = readEnv(env, 'PEACH_ORCHESTRATION_PAYMENT_RESPONSE_HASH_KEY')

  if (!customSecretValue && !paymentResponseHashKey) return null

  if (!customSecretValue) {
    throw new OrchestrationWebhookConfigurationError('PEACH_ORCHESTRATION_WEBHOOK_SECRET is required once Orchestration webhook auth is configured')
  }
  if (!paymentResponseHashKey) {
    throw new OrchestrationWebhookConfigurationError(
      'PEACH_ORCHESTRATION_PAYMENT_RESPONSE_HASH_KEY is required once Orchestration webhook auth is configured'
    )
  }

  return { customSecretHeaderName: ORCHESTRATION_WEBHOOK_SECRET_HEADER, customSecretValue, paymentResponseHashKey }
}

/**
 * Fail-closed entry point for the webhook route: unlike
 * loadOrchestrationWebhookConfig() (which returns null for "not
 * configured yet"), this throws -- the webhook path itself must never
 * silently proceed as if authentication were possible when it isn't.
 */
export function requireOrchestrationWebhookConfig(env: NodeJS.ProcessEnv = process.env): OrchestrationWebhookConfig {
  const config = loadOrchestrationWebhookConfig(env)
  if (!config) {
    throw new OrchestrationWebhookConfigurationError(
      'Peach Orchestration webhook authentication is not configured (PEACH_ORCHESTRATION_WEBHOOK_SECRET / PEACH_ORCHESTRATION_PAYMENT_RESPONSE_HASH_KEY)'
    )
  }
  return config
}
