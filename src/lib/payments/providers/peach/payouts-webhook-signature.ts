import { createHmac, timingSafeEqual } from 'crypto'

/**
 * E32: Peach Payouts/BANV webhooks are signed using the Svix /
 * "Standard Webhooks" scheme (confirmed live this phase: Peach's own
 * docs name `webhook-id`/`webhook-timestamp` headers and explicitly
 * point integrators at "Svix libraries or manual verification"). This
 * is a DIFFERENT scheme from Checkout's own `x-webhook-signature`
 * family in ./signature.ts -- different headers (no `x-` prefix),
 * different signed string, different secret format. The algorithm
 * itself (https://www.standardwebhooks.com/) is a stable, publicly
 * documented spec independent of any Peach-specific ambiguity, so
 * implementing it directly here does not require the same "insufficient
 * evidence" caution this phase applied to the refund-contract question.
 *
 * Secret format: `whsec_<base64>`. Signed content:
 * `${webhookId}.${webhookTimestamp}.${rawBody}`. Signature header
 * carries one or more space-separated `v1,<base64sig>` tokens (plural to
 * support secret rotation) -- valid if ANY token matches.
 */

const DEFAULT_TOLERANCE_SECONDS = 300

export interface PayoutsWebhookVerification {
  valid: boolean
  reason?: string
}

export function verifyPayoutsWebhookSignature(params: {
  headers: Record<string, string | null>
  rawBody: string
  secret: string
  toleranceSeconds?: number
}): PayoutsWebhookVerification {
  const { headers, rawBody, secret, toleranceSeconds = DEFAULT_TOLERANCE_SECONDS } = params
  const webhookId = headers['webhook-id']
  const webhookTimestamp = headers['webhook-timestamp']
  const webhookSignature = headers['webhook-signature']

  if (!webhookId || !webhookTimestamp || !webhookSignature) {
    return { valid: false, reason: 'missing one or more of webhook-id / webhook-timestamp / webhook-signature' }
  }
  if (!secret.startsWith('whsec_')) {
    return { valid: false, reason: 'signing secret must be in whsec_ format' }
  }

  const timestampSeconds = Number(webhookTimestamp)
  if (!Number.isFinite(timestampSeconds)) {
    return { valid: false, reason: 'webhook-timestamp is not a valid number' }
  }
  const nowSeconds = Date.now() / 1000
  if (Math.abs(nowSeconds - timestampSeconds) > toleranceSeconds) {
    return { valid: false, reason: 'webhook-timestamp is outside the allowed tolerance window' }
  }

  let secretBytes: Buffer
  try {
    secretBytes = Buffer.from(secret.slice('whsec_'.length), 'base64')
  } catch {
    return { valid: false, reason: 'signing secret is not valid base64' }
  }

  const signedContent = `${webhookId}.${webhookTimestamp}.${rawBody}`
  const expected = createHmac('sha256', secretBytes).update(signedContent).digest('base64')
  const expectedBuf = Buffer.from(expected, 'base64')

  const candidates = webhookSignature
    .split(' ')
    .map((token) => token.trim())
    .filter(Boolean)

  for (const candidate of candidates) {
    const [version, sigBase64] = candidate.split(',')
    if (version !== 'v1' || !sigBase64) continue
    let candidateBuf: Buffer
    try {
      candidateBuf = Buffer.from(sigBase64, 'base64')
    } catch {
      continue
    }
    if (candidateBuf.length === expectedBuf.length && timingSafeEqual(candidateBuf, expectedBuf)) {
      return { valid: true }
    }
  }

  return { valid: false, reason: 'signature mismatch' }
}
