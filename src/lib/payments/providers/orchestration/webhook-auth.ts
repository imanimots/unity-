import { createHmac, timingSafeEqual } from 'crypto'
import { ORCHESTRATION_WEBHOOK_SECRET_HEADER, ORCHESTRATION_WEBHOOK_SIGNATURE_HEADER, type OrchestrationWebhookConfig } from './webhook-config'

/**
 * Peach Orchestration webhook authentication (P5D-B) -- two independent
 * layers, both required (P5D-A.1's accepted design, corrected in
 * P5D-M1.1's review). Deliberately NOT built on top of
 * PeachPaymentsProvider.verifyWebhook() / the generic
 * WebhookVerificationInput/Result shapes in ../provider.ts: those exist
 * for the classic Checkout (HMAC-SHA256) and OPPWA (AES-256-GCM)
 * schemes, which are genuinely different cryptography from
 * Orchestration's HMAC-SHA512 -- reusing that interface here would risk
 * exactly the "accidentally route classic verification through
 * Orchestration parsing" mistake this phase is required to avoid. This
 * module is Orchestration-only, called directly by the webhook route
 * when it detects an Orchestration delivery (before the generic
 * dispatch), never merged into the shared PaymentProvider contract.
 */

export interface OrchestrationAuthResult {
  valid: boolean
  /** Safe to log -- never includes a secret value or the raw header content. */
  reason: string
}

/**
 * Constant-time string comparison, safe for unequal lengths (the naive
 * `timingSafeEqual` call throws on a length mismatch rather than
 * returning false, which would otherwise leak length information via a
 * thrown-vs-not-thrown timing difference if callers didn't guard it --
 * this function guards it once, here, so every caller gets the safe
 * behavior for free).
 */
function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf-8')
  const bufB = Buffer.from(b, 'utf-8')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

/**
 * Layer 1 -- dedicated custom secret header. Absent header, or a value
 * that doesn't match, are both `valid: false` with the same generic
 * reason -- never distinguishing "missing" from "wrong" to a caller that
 * might expose that to a response (see the route: this internal `reason`
 * is for safe structured logs only, never echoed to the requester).
 */
export function verifyOrchestrationWebhookSecret(headers: Record<string, string | null>, config: OrchestrationWebhookConfig): OrchestrationAuthResult {
  const received = headers[config.customSecretHeaderName]
  if (!received) {
    return { valid: false, reason: 'missing custom secret header' }
  }
  if (!constantTimeEquals(received, config.customSecretValue)) {
    return { valid: false, reason: 'custom secret header did not match' }
  }
  return { valid: true, reason: 'custom secret header matched' }
}

const HEX_SIGNATURE_PATTERN = /^[0-9a-f]+$/i

/**
 * Layer 2 -- Peach's confirmed HMAC-SHA512 webhook signature (P5D-A.1
 * evidence: header `x-webhook-signature-512`, key
 * `payment_response_hash_key`, canonical input the exact raw request
 * body bytes -- "Get the raw request body (as bytes, before parsing)",
 * never a re-serialized/re-parsed JSON object).
 *
 * `rawBodyBytes` MUST be the literal `Buffer` the HTTP stream produced
 * -- never a decoded-then-re-encoded string (P5D-B.1 correction: that
 * round-trip is only lossless for input that is already valid UTF-8;
 * see webhook-body-reader.ts's own comment for the proof). Passing a
 * `Buffer` here, rather than a `string`, is a deliberate type-level
 * guard against ever re-introducing that defect -- there is no decode
 * step between "bytes received" and "bytes hashed".
 */
export function verifyOrchestrationWebhookSignature(
  rawBodyBytes: Buffer,
  headers: Record<string, string | null>,
  config: OrchestrationWebhookConfig
): OrchestrationAuthResult {
  const received = headers[ORCHESTRATION_WEBHOOK_SIGNATURE_HEADER]
  if (!received) {
    return { valid: false, reason: 'missing HMAC signature header' }
  }
  if (received.length === 0 || !HEX_SIGNATURE_PATTERN.test(received)) {
    return { valid: false, reason: 'malformed HMAC signature encoding' }
  }

  const expected = createHmac('sha512', config.paymentResponseHashKey).update(rawBodyBytes).digest('hex')

  if (!constantTimeEquals(received.toLowerCase(), expected)) {
    return { valid: false, reason: 'HMAC signature did not match' }
  }
  return { valid: true, reason: 'HMAC signature matched' }
}

/**
 * Both layers required, no weak fallback to one alone (P5D-A.1's
 * explicit acceptance criterion). Short-circuits on Layer 1 failure --
 * still safe (never processes the body either way on failure), and
 * avoids spending an HMAC computation on a request that's already
 * rejected. Takes the raw bytes, never a decoded string -- see
 * verifyOrchestrationWebhookSignature's own comment.
 */
export function verifyOrchestrationWebhook(rawBodyBytes: Buffer, headers: Record<string, string | null>, config: OrchestrationWebhookConfig): OrchestrationAuthResult {
  const secretResult = verifyOrchestrationWebhookSecret(headers, config)
  if (!secretResult.valid) return secretResult

  const signatureResult = verifyOrchestrationWebhookSignature(rawBodyBytes, headers, config)
  if (!signatureResult.valid) return signatureResult

  return { valid: true, reason: 'both authentication layers passed' }
}

export { ORCHESTRATION_WEBHOOK_SECRET_HEADER, ORCHESTRATION_WEBHOOK_SIGNATURE_HEADER }
