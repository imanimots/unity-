import { describe, it, expect } from 'vitest'
import { createHmac } from 'crypto'
import { verifyPayoutsWebhookSignature } from '../payouts-webhook-signature'

const SECRET_BYTES = Buffer.from('test-signing-key-bytes-0123456789')
const SECRET = `whsec_${SECRET_BYTES.toString('base64')}`

function sign(webhookId: string, timestamp: string, rawBody: string): string {
  const signedContent = `${webhookId}.${timestamp}.${rawBody}`
  const sig = createHmac('sha256', SECRET_BYTES).update(signedContent).digest('base64')
  return `v1,${sig}`
}

describe('verifyPayoutsWebhookSignature -- Standard Webhooks/Svix scheme', () => {
  it('1. accepts a correctly signed payload', () => {
    const rawBody = '{"status":"successful"}'
    const webhookId = 'msg_123'
    const timestamp = String(Math.floor(Date.now() / 1000))
    const signature = sign(webhookId, timestamp, rawBody)

    const result = verifyPayoutsWebhookSignature({
      headers: { 'webhook-id': webhookId, 'webhook-timestamp': timestamp, 'webhook-signature': signature },
      rawBody,
      secret: SECRET,
    })

    expect(result.valid).toBe(true)
  })

  it('2. rejects a tampered body', () => {
    const rawBody = '{"status":"successful"}'
    const webhookId = 'msg_123'
    const timestamp = String(Math.floor(Date.now() / 1000))
    const signature = sign(webhookId, timestamp, rawBody)

    const result = verifyPayoutsWebhookSignature({
      headers: { 'webhook-id': webhookId, 'webhook-timestamp': timestamp, 'webhook-signature': signature },
      rawBody: '{"status":"failed"}',
      secret: SECRET,
    })

    expect(result.valid).toBe(false)
    expect(result.reason).toBe('signature mismatch')
  })

  it('3. rejects when any of the three headers is missing', () => {
    const result = verifyPayoutsWebhookSignature({
      headers: { 'webhook-id': 'msg_123', 'webhook-timestamp': null, 'webhook-signature': 'v1,abc' },
      rawBody: '{}',
      secret: SECRET,
    })
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/missing/)
  })

  it('4. rejects a timestamp outside the tolerance window (replay protection)', () => {
    const rawBody = '{}'
    const webhookId = 'msg_123'
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 10_000)
    const signature = sign(webhookId, staleTimestamp, rawBody)

    const result = verifyPayoutsWebhookSignature({
      headers: { 'webhook-id': webhookId, 'webhook-timestamp': staleTimestamp, 'webhook-signature': signature },
      rawBody,
      secret: SECRET,
    })

    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/tolerance/)
  })

  it('5. rejects a secret not in whsec_ format', () => {
    const result = verifyPayoutsWebhookSignature({
      headers: { 'webhook-id': 'msg_123', 'webhook-timestamp': String(Math.floor(Date.now() / 1000)), 'webhook-signature': 'v1,abc' },
      rawBody: '{}',
      secret: 'not-a-whsec-secret',
    })
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/whsec_/)
  })

  it('6. accepts when the matching signature is one of several space-separated tokens (secret rotation)', () => {
    const rawBody = '{"status":"successful"}'
    const webhookId = 'msg_123'
    const timestamp = String(Math.floor(Date.now() / 1000))
    const realSignature = sign(webhookId, timestamp, rawBody)
    const decoySignature = 'v1,deadbeef=='

    const result = verifyPayoutsWebhookSignature({
      headers: { 'webhook-id': webhookId, 'webhook-timestamp': timestamp, 'webhook-signature': `${decoySignature} ${realSignature}` },
      rawBody,
      secret: SECRET,
    })

    expect(result.valid).toBe(true)
  })

  it('7. rejects a signature token with an unrecognized version prefix', () => {
    const rawBody = '{}'
    const webhookId = 'msg_123'
    const timestamp = String(Math.floor(Date.now() / 1000))

    const result = verifyPayoutsWebhookSignature({
      headers: { 'webhook-id': webhookId, 'webhook-timestamp': timestamp, 'webhook-signature': 'v2,someSignature==' },
      rawBody,
      secret: SECRET,
    })

    expect(result.valid).toBe(false)
  })
})
