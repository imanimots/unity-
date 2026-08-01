import { createHmac, createDecipheriv, timingSafeEqual } from 'crypto'

/**
 * Peach's Checkout/Payment-Links webhooks (docs/checkout-webhooks) are
 * HMAC-SHA256 signed over `${timestamp}.${webhookId}.${url}.${payload}`,
 * verified against four headers: `x-webhook-signature`,
 * `x-webhook-timestamp`, `x-webhook-id`, `x-webhook-signature-algorithm`.
 * `url` is the full webhook endpoint URL as registered with Peach --
 * passed in by the caller (the route knows its own URL; this function
 * has no way to know it).
 */
export interface CheckoutSignatureVerification {
  valid: boolean
  reason?: string
}

export function verifyCheckoutSignature(params: {
  headers: Record<string, string | null>
  rawBody: string
  webhookUrl: string
  secret: string
}): CheckoutSignatureVerification {
  const { headers, rawBody, webhookUrl, secret } = params
  const signature = headers['x-webhook-signature']
  const timestamp = headers['x-webhook-timestamp']
  const webhookId = headers['x-webhook-id']

  if (!signature || !timestamp || !webhookId) {
    return { valid: false, reason: 'missing one or more of x-webhook-signature / x-webhook-timestamp / x-webhook-id' }
  }

  const signedString = `${timestamp}.${webhookId}.${webhookUrl}.${rawBody}`
  const expected = createHmac('sha256', secret).update(signedString).digest('hex')

  const expectedBuf = Buffer.from(expected, 'hex')
  const actualBuf = Buffer.from(signature, 'hex')
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    return { valid: false, reason: 'signature mismatch' }
  }
  return { valid: true }
}

/**
 * OPPWA webhooks (docs/oppwa-guides-webhooks) are encrypted, not merely
 * signed -- AES-256-GCM, keyed by a shared secret from the Dashboard, with
 * the IV and auth tag carried in `X-Initialization-Vector` /
 * `X-Authentication-Tag` headers (hex-encoded). The encrypted body itself
 * arrives either as a bare hex string or JSON-wrapped as
 * `{"encryptedBody": "..."}` -- both are handled here since the
 * documentation states both occur depending on integration.
 */
export interface OppwaDecryptionResult {
  payload: unknown | null
  reason?: string
}

export function decryptOppwaWebhook(params: { headers: Record<string, string | null>; rawBody: string; keyHex: string }): OppwaDecryptionResult {
  const { headers, rawBody, keyHex } = params
  const ivHex = headers['x-initialization-vector']
  const tagHex = headers['x-authentication-tag']

  if (!ivHex || !tagHex) {
    return { payload: null, reason: 'missing X-Initialization-Vector or X-Authentication-Tag header' }
  }

  let ciphertextHex = rawBody.trim()
  try {
    const parsed = JSON.parse(rawBody)
    if (parsed && typeof parsed === 'object' && typeof parsed.encryptedBody === 'string') {
      ciphertextHex = parsed.encryptedBody
    }
  } catch {
    // not JSON -- treat the whole raw body as the hex ciphertext, per spec
  }

  try {
    const key = Buffer.from(keyHex, 'hex')
    const iv = Buffer.from(ivHex, 'hex')
    const authTag = Buffer.from(tagHex, 'hex')
    const ciphertext = Buffer.from(ciphertextHex, 'hex')

    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(authTag)
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return { payload: JSON.parse(decrypted.toString('utf8')) }
  } catch (err) {
    return { payload: null, reason: `decryption failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}
