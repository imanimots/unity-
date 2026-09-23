import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHmac, createCipheriv, randomBytes } from 'crypto'
import { PeachPaymentsProvider } from '../peach-provider'
import { NotImplementedError } from '../../provider'

const ORIGINAL_ENV = { ...process.env }

function resetEnv() {
  Object.keys(process.env).forEach((key) => {
    if (key.startsWith('PEACH_')) delete process.env[key]
  })
  Object.assign(process.env, ORIGINAL_ENV)
}

function setOrchestrationEnv() {
  process.env.PEACH_ORCHESTRATION_ENVIRONMENT = 'sandbox'
  process.env.PEACH_ORCHESTRATION_API_BASE_URL = 'https://sandbox.example/orchestration'
  process.env.PEACH_ORCHESTRATION_API_KEY = 'test-key-not-real'
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('PeachPaymentsProvider.healthCheck', () => {
  beforeEach(resetEnv)
  afterEach(resetEnv)

  it('is unhealthy with no config at all set (a configuration error, not a thrown exception)', async () => {
    const health = await new PeachPaymentsProvider().healthCheck()
    expect(health.healthy).toBe(false)
    // Classic's own "PEACH_ENVIRONMENT must be..." detail is still
    // surfaced (verifyWebhook still depends on it), just no longer the
    // primary healthy/unhealthy signal -- see the next describe block
    // ("P5C: healthCheck is Orchestration-primary").
    expect(health.detail).toMatch(/PEACH_ENVIRONMENT/)
  })

  it('is unhealthy when only classic PEACH_ENVIRONMENT is set (Orchestration, not classic, is now the primary signal)', async () => {
    process.env.PEACH_ENVIRONMENT = 'sandbox'
    const health = await new PeachPaymentsProvider().healthCheck()
    expect(health.healthy).toBe(false)
  })

  it('never throws, even with a malformed classic environment value -- safe for monitoring to call', async () => {
    process.env.PEACH_ENVIRONMENT = 'not-a-real-environment'
    await expect(new PeachPaymentsProvider().healthCheck()).resolves.toMatchObject({ healthy: false })
  })
})

describe('PeachPaymentsProvider.healthCheck -- P5C: Orchestration-primary', () => {
  beforeEach(resetEnv)
  afterEach(resetEnv)

  it('is UNhealthy when only a classic credential block is configured -- classic config alone is no longer sufficient (P5C behavior change, intentional: captureDeposit/releaseDeposit are now wired to Orchestration, not classic)', async () => {
    process.env.PEACH_ENVIRONMENT = 'sandbox'
    process.env.PEACH_PAYOUTS_API_BEARER_TOKEN = 'tok'
    const health = await new PeachPaymentsProvider().healthCheck()
    expect(health.healthy).toBe(false)
    expect(health.detail).toContain('orchestration: not configured')
  })

  it('is healthy once Orchestration is configured, regardless of classic config state', async () => {
    setOrchestrationEnv()
    const health = await new PeachPaymentsProvider().healthCheck()
    expect(health.healthy).toBe(true)
    expect(health.provider).toBe('peach')
    expect(health.detail).toContain('orchestration: environment=sandbox')
  })

  it('never includes the Orchestration api-key value in the detail string', async () => {
    setOrchestrationEnv()
    const health = await new PeachPaymentsProvider().healthCheck()
    expect(health.detail).not.toContain('test-key-not-real')
  })
})

describe('PeachPaymentsProvider.verifyWebhook (unchanged by P5C -- explicitly P5D scope)', () => {
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

describe('PeachPaymentsProvider -- P5C: Orchestration wiring', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    resetEnv()
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
    resetEnv()
  })

  describe('chargeRental / authorizeDeposit -- deliberately not wired this phase', () => {
    it('chargeRental throws NotImplementedError with a specific, accurate reason (Hosted Checkout session creation is asynchronous)', async () => {
      const provider = new PeachPaymentsProvider()
      await expect(provider.chargeRental({ paymentId: 'p1', providerReference: '', amount: 92, currency: 'ZAR' })).rejects.toThrow(NotImplementedError)
      await expect(provider.chargeRental({ paymentId: 'p1', providerReference: '', amount: 92, currency: 'ZAR' })).rejects.toThrow(/asynchronous/)
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('authorizeDeposit throws NotImplementedError with a specific, accurate reason', async () => {
      const provider = new PeachPaymentsProvider()
      await expect(provider.authorizeDeposit({ paymentId: 'p1', providerReference: '', amount: 500, currency: 'ZAR' })).rejects.toThrow(NotImplementedError)
      expect(fetchSpy).not.toHaveBeenCalled()
    })
  })

  describe('captureDeposit -- wired to POST /payments/{id}/capture', () => {
    it('captures successfully and maps succeeded -> captured', async () => {
      setOrchestrationEnv()
      fetchSpy.mockResolvedValue(jsonResponse(200, { payment_id: 'pay_123', status: 'succeeded' }))
      const result = await new PeachPaymentsProvider().captureDeposit({ paymentId: 'p1', providerReference: 'pay_123', amount: 500, currency: 'ZAR' })

      expect(result).toEqual({ providerReference: 'pay_123', status: 'captured' })
      const [url, init] = fetchSpy.mock.calls[0]
      expect(url).toBe('https://sandbox.example/orchestration/payments/pay_123/capture')
      expect(init.headers['api-key']).toBe('test-key-not-real')
    })

    it('maps partially_captured -> captured', async () => {
      setOrchestrationEnv()
      fetchSpy.mockResolvedValue(jsonResponse(200, { payment_id: 'pay_123', status: 'partially_captured' }))
      const result = await new PeachPaymentsProvider().captureDeposit({ paymentId: 'p1', providerReference: 'pay_123', amount: 100, currency: 'ZAR' })
      expect(result.status).toBe('captured')
    })

    it('maps a non-success status to failed', async () => {
      setOrchestrationEnv()
      fetchSpy.mockResolvedValue(jsonResponse(200, { payment_id: 'pay_123', status: 'failed' }))
      const result = await new PeachPaymentsProvider().captureDeposit({ paymentId: 'p1', providerReference: 'pay_123', amount: 500, currency: 'ZAR' })
      expect(result.status).toBe('failed')
    })

    it('throws NotImplementedError (not a silent no-op) when providerReference is missing', async () => {
      setOrchestrationEnv()
      await expect(new PeachPaymentsProvider().captureDeposit({ paymentId: 'p1', providerReference: '', amount: 500, currency: 'ZAR' })).rejects.toThrow(
        NotImplementedError
      )
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('throws when Orchestration is not configured, without making a network call', async () => {
      await expect(
        new PeachPaymentsProvider().captureDeposit({ paymentId: 'p1', providerReference: 'pay_123', amount: 500, currency: 'ZAR' })
      ).rejects.toThrow()
      expect(fetchSpy).not.toHaveBeenCalled()
    })
  })

  describe('releaseDeposit -- wired to POST /payments/{id}/cancel', () => {
    it('releases successfully and maps cancelled -> released', async () => {
      setOrchestrationEnv()
      fetchSpy.mockResolvedValue(jsonResponse(200, { payment_id: 'pay_123', status: 'cancelled' }))
      const result = await new PeachPaymentsProvider().releaseDeposit({ paymentId: 'p1', providerReference: 'pay_123', amount: 0, currency: 'ZAR' })
      expect(result).toEqual({ providerReference: 'pay_123', status: 'released' })
      const [url] = fetchSpy.mock.calls[0]
      expect(url).toBe('https://sandbox.example/orchestration/payments/pay_123/cancel')
    })

    it('maps a non-cancelled status to failed', async () => {
      setOrchestrationEnv()
      fetchSpy.mockResolvedValue(jsonResponse(200, { payment_id: 'pay_123', status: 'succeeded' }))
      const result = await new PeachPaymentsProvider().releaseDeposit({ paymentId: 'p1', providerReference: 'pay_123', amount: 0, currency: 'ZAR' })
      expect(result.status).toBe('failed')
    })
  })
})
