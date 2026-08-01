import { describe, it, expect } from 'vitest'
import { createHmac, createCipheriv, randomBytes } from 'crypto'
import { verifyCheckoutSignature, decryptOppwaWebhook } from '../signature'

describe('verifyCheckoutSignature', () => {
  const secret = 'checkout-secret'
  const webhookUrl = 'https://unity.example/api/payments/webhooks/peach'
  const rawBody = JSON.stringify({ id: 'txn_1', type: 'Successful' })
  const timestamp = '2026-07-31T12:00:00.000Z'
  const webhookId = 'wh_evt_1'

  function sign(ts: string, id: string, url: string, body: string): string {
    return createHmac('sha256', secret).update(`${ts}.${id}.${url}.${body}`).digest('hex')
  }

  it('accepts a correctly computed signature', () => {
    const signature = sign(timestamp, webhookId, webhookUrl, rawBody)
    const result = verifyCheckoutSignature({
      headers: { 'x-webhook-signature': signature, 'x-webhook-timestamp': timestamp, 'x-webhook-id': webhookId },
      rawBody,
      webhookUrl,
      secret,
    })
    expect(result.valid).toBe(true)
  })

  it('rejects a tampered body even with an otherwise-valid signature for the original body', () => {
    const signature = sign(timestamp, webhookId, webhookUrl, rawBody)
    const result = verifyCheckoutSignature({
      headers: { 'x-webhook-signature': signature, 'x-webhook-timestamp': timestamp, 'x-webhook-id': webhookId },
      rawBody: JSON.stringify({ id: 'txn_1', type: 'Successful', amount: '999999.00' }),
      webhookUrl,
      secret,
    })
    expect(result.valid).toBe(false)
  })

  it('rejects when signed with the wrong secret', () => {
    const wrongSignature = createHmac('sha256', 'not-the-real-secret').update(`${timestamp}.${webhookId}.${webhookUrl}.${rawBody}`).digest('hex')
    const result = verifyCheckoutSignature({
      headers: { 'x-webhook-signature': wrongSignature, 'x-webhook-timestamp': timestamp, 'x-webhook-id': webhookId },
      rawBody,
      webhookUrl,
      secret,
    })
    expect(result.valid).toBe(false)
  })

  it('rejects when the registered webhook URL differs from what was signed', () => {
    const signature = sign(timestamp, webhookId, webhookUrl, rawBody)
    const result = verifyCheckoutSignature({
      headers: { 'x-webhook-signature': signature, 'x-webhook-timestamp': timestamp, 'x-webhook-id': webhookId },
      rawBody,
      webhookUrl: 'https://unity.example/some-other-path',
      secret,
    })
    expect(result.valid).toBe(false)
  })

  it('rejects when required headers are missing', () => {
    const result = verifyCheckoutSignature({ headers: {}, rawBody, webhookUrl, secret })
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/missing/)
  })
})

describe('decryptOppwaWebhook', () => {
  const keyHex = randomBytes(32).toString('hex')

  function encrypt(plaintext: string) {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv)
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const authTag = cipher.getAuthTag()
    return { ivHex: iv.toString('hex'), tagHex: authTag.toString('hex'), ciphertextHex: ciphertext.toString('hex') }
  }

  it('decrypts a correctly encrypted bare-hex body', () => {
    const plaintext = JSON.stringify({ type: 'PAYMENT', payload: { id: 'txn_1', paymentType: 'PA' } })
    const { ivHex, tagHex, ciphertextHex } = encrypt(plaintext)
    const result = decryptOppwaWebhook({
      headers: { 'x-initialization-vector': ivHex, 'x-authentication-tag': tagHex },
      rawBody: ciphertextHex,
      keyHex,
    })
    expect(result.payload).toEqual({ type: 'PAYMENT', payload: { id: 'txn_1', paymentType: 'PA' } })
  })

  it('decrypts a correctly encrypted JSON-wrapped {"encryptedBody": "..."} body', () => {
    const plaintext = JSON.stringify({ type: 'REGISTRATION', action: 'CREATED' })
    const { ivHex, tagHex, ciphertextHex } = encrypt(plaintext)
    const result = decryptOppwaWebhook({
      headers: { 'x-initialization-vector': ivHex, 'x-authentication-tag': tagHex },
      rawBody: JSON.stringify({ encryptedBody: ciphertextHex }),
      keyHex,
    })
    expect(result.payload).toEqual({ type: 'REGISTRATION', action: 'CREATED' })
  })

  it('fails closed (null payload) when the auth tag does not match (tampered ciphertext)', () => {
    const plaintext = JSON.stringify({ type: 'PAYMENT' })
    const { ivHex, tagHex, ciphertextHex } = encrypt(plaintext)
    const tampered = ciphertextHex.slice(0, -2) + (ciphertextHex.slice(-2) === '00' ? '01' : '00')
    const result = decryptOppwaWebhook({
      headers: { 'x-initialization-vector': ivHex, 'x-authentication-tag': tagHex },
      rawBody: tampered,
      keyHex,
    })
    expect(result.payload).toBeNull()
    expect(result.reason).toMatch(/decryption failed/)
  })

  it('fails closed when decrypted with the wrong key', () => {
    const plaintext = JSON.stringify({ type: 'PAYMENT' })
    const { ivHex, tagHex, ciphertextHex } = encrypt(plaintext)
    const result = decryptOppwaWebhook({
      headers: { 'x-initialization-vector': ivHex, 'x-authentication-tag': tagHex },
      rawBody: ciphertextHex,
      keyHex: randomBytes(32).toString('hex'),
    })
    expect(result.payload).toBeNull()
  })

  it('reports a clear reason when the required headers are missing', () => {
    const result = decryptOppwaWebhook({ headers: {}, rawBody: 'abcd', keyHex })
    expect(result.payload).toBeNull()
    expect(result.reason).toMatch(/missing/)
  })
})
