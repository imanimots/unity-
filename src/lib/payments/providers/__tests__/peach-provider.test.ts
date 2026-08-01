import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHmac, createCipheriv, randomBytes } from 'crypto'
import { PeachPaymentsProvider } from '../peach-provider'

const ORIGINAL_ENV = { ...process.env }

function resetEnv() {
  Object.keys(process.env).forEach((key) => {
    if (key.startsWith('PEACH_')) delete process.env[key]
  })
  Object.assign(process.env, ORIGINAL_ENV)
}

describe('PeachPaymentsProvider.healthCheck', () => {
  beforeEach(resetEnv)
  afterEach(resetEnv)

  it('is unhealthy with no PEACH_ENVIRONMENT set (a configuration error, not a thrown exception)', async () => {
    delete process.env.PEACH_ENVIRONMENT
    const health = await new PeachPaymentsProvider().healthCheck()
    expect(health.healthy).toBe(false)
    expect(health.detail).toMatch(/PEACH_ENVIRONMENT/)
  })

  it('is unhealthy when PEACH_ENVIRONMENT is set but no credential block is configured', async () => {
    process.env.PEACH_ENVIRONMENT = 'sandbox'
    const health = await new PeachPaymentsProvider().healthCheck()
    expect(health.healthy).toBe(false)
  })

  it('is healthy once at least one credential block is fully configured', async () => {
    process.env.PEACH_ENVIRONMENT = 'sandbox'
    process.env.PEACH_PAYOUTS_API_BEARER_TOKEN = 'tok'
    const health = await new PeachPaymentsProvider().healthCheck()
    expect(health.healthy).toBe(true)
    expect(health.provider).toBe('peach')
  })

  it('never throws, even with a malformed environment value -- safe for monitoring to call', async () => {
    process.env.PEACH_ENVIRONMENT = 'not-a-real-environment'
    await expect(new PeachPaymentsProvider().healthCheck()).resolves.toMatchObject({ healthy: false })
  })
})

describe('PeachPaymentsProvider.verifyWebhook', () => {
  beforeEach(resetEnv)
  afterEach(resetEnv)

  describe('Checkout-style (HMAC) webhooks', () => {
    const secret = 'checkout-secret'
    const webhookUrl = 'https://unity.example/api/payments/webhooks/peach'

    beforeEach(() => {
      process.env.PEACH_ENVIRONMENT = 'sandbox'
      process.env.PEACH_CHECKOUT_ENTITY_ID = 'e1'
      process.env.PEACH_CHECKOUT_WEBHOOK_SIGNING_SECRET = secret
      process.env.PEACH_CHECKOUT_WEBHOOK_URL = webhookUrl
    })

    it('accepts a correctly signed webhook and extracts the transaction id as providerEventId', async () => {
      const rawBody = JSON.stringify({ id: 'txn_1', merchantTransactionId: 'unity-b1', type: 'Successful', result: { code: '000.000.000' } })
      const timestamp = '2026-07-31T12:00:00.000Z'
      const webhookId = 'wh_1'
      const signature = createHmac('sha256', secret).update(`${timestamp}.${webhookId}.${webhookUrl}.${rawBody}`).digest('hex')

      const result = await new PeachPaymentsProvider().verifyWebhook({
        rawBody,
        headers: { 'x-webhook-signature': signature, 'x-webhook-timestamp': timestamp, 'x-webhook-id': webhookId },
      })
      expect(result.valid).toBe(true)
      expect(result.providerEventId).toBe('txn_1')
    })

    it('rejects a forged signature', async () => {
      const rawBody = JSON.stringify({ id: 'txn_1', type: 'Successful' })
      const result = await new PeachPaymentsProvider().verifyWebhook({
        rawBody,
        headers: { 'x-webhook-signature': 'forged', 'x-webhook-timestamp': 't', 'x-webhook-id': 'wh_1' },
      })
      expect(result.valid).toBe(false)
      expect(result.providerEventId).toBeNull()
    })

    it('is unverifiable (not trusted) when Checkout is not configured, even with a plausible-looking signature header', async () => {
      delete process.env.PEACH_CHECKOUT_ENTITY_ID
      const result = await new PeachPaymentsProvider().verifyWebhook({
        rawBody: '{}',
        headers: { 'x-webhook-signature': 'anything', 'x-webhook-timestamp': 't', 'x-webhook-id': 'wh_1' },
      })
      expect(result.valid).toBe(false)
    })
  })

  describe('OPPWA-style (encrypted) webhooks', () => {
    const keyHex = randomBytes(32).toString('hex')

    beforeEach(() => {
      process.env.PEACH_ENVIRONMENT = 'sandbox'
      process.env.PEACH_CARD_API_BACKOFFICE_BEARER_TOKEN = 'tok'
      process.env.PEACH_CARD_API_WEBHOOK_DECRYPTION_KEY = keyHex
    })

    it('decrypts and accepts a correctly encrypted webhook', async () => {
      const plaintext = JSON.stringify({ type: 'PAYMENT', payload: { id: 'txn_2', paymentType: 'CP', result: { code: '000.000.000' } } })
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv)
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      const authTag = cipher.getAuthTag()

      const result = await new PeachPaymentsProvider().verifyWebhook({
        rawBody: ciphertext.toString('hex'),
        headers: { 'x-initialization-vector': iv.toString('hex'), 'x-authentication-tag': authTag.toString('hex') },
      })
      expect(result.valid).toBe(true)
      expect(result.providerEventId).toBe('txn_2')
    })

    it('rejects when the ciphertext has been tampered with', async () => {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv)
      const ciphertext = Buffer.concat([cipher.update('{}', 'utf8'), cipher.final()])
      const authTag = cipher.getAuthTag()
      const tampered = ciphertext.toString('hex').slice(0, -2) + '00'

      const result = await new PeachPaymentsProvider().verifyWebhook({
        rawBody: tampered,
        headers: { 'x-initialization-vector': iv.toString('hex'), 'x-authentication-tag': authTag.toString('hex') },
      })
      expect(result.valid).toBe(false)
    })
  })

  describe('Payouts webhooks (no confirmed signature scheme)', () => {
    beforeEach(() => {
      process.env.PEACH_ENVIRONMENT = 'sandbox'
      process.env.PEACH_PAYOUTS_API_BEARER_TOKEN = 'tok'
    })

    it('is deliberately never trusted -- treated as invalid rather than assumed-safe unsigned', async () => {
      const result = await new PeachPaymentsProvider().verifyWebhook({
        rawBody: JSON.stringify({ payoutId: 'po_1', status: 'successful' }),
        headers: {},
      })
      expect(result.valid).toBe(false)
      expect(result.payload).toBeNull()
    })
  })
})
