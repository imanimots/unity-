import { describe, it, expect } from 'vitest'
import { createHmac } from 'crypto'
import { verifyOrchestrationWebhookSecret, verifyOrchestrationWebhookSignature, verifyOrchestrationWebhook } from '../webhook-auth'
import { ORCHESTRATION_WEBHOOK_SECRET_HEADER, ORCHESTRATION_WEBHOOK_SIGNATURE_HEADER, type OrchestrationWebhookConfig } from '../webhook-config'

const CONFIG: OrchestrationWebhookConfig = {
  customSecretHeaderName: ORCHESTRATION_WEBHOOK_SECRET_HEADER,
  customSecretValue: 'a-high-entropy-custom-secret-value',
  paymentResponseHashKey: 'a-high-entropy-payment-response-hash-key',
}

function sign(body: string, key: string): string {
  return createHmac('sha512', key).update(Buffer.from(body, 'utf-8')).digest('hex')
}

describe('verifyOrchestrationWebhookSecret (Layer 1)', () => {
  it('passes when the custom secret header matches exactly', () => {
    const result = verifyOrchestrationWebhookSecret({ [ORCHESTRATION_WEBHOOK_SECRET_HEADER]: CONFIG.customSecretValue }, CONFIG)
    expect(result.valid).toBe(true)
  })

  it('rejects when the header is absent', () => {
    const result = verifyOrchestrationWebhookSecret({}, CONFIG)
    expect(result.valid).toBe(false)
  })

  it('rejects when the header value is wrong', () => {
    const result = verifyOrchestrationWebhookSecret({ [ORCHESTRATION_WEBHOOK_SECRET_HEADER]: 'wrong-value' }, CONFIG)
    expect(result.valid).toBe(false)
  })

  it('safely rejects an unequal-length secret rather than throwing', () => {
    expect(() => verifyOrchestrationWebhookSecret({ [ORCHESTRATION_WEBHOOK_SECRET_HEADER]: 'short' }, CONFIG)).not.toThrow()
    const result = verifyOrchestrationWebhookSecret({ [ORCHESTRATION_WEBHOOK_SECRET_HEADER]: 'short' }, CONFIG)
    expect(result.valid).toBe(false)
  })

  it('never includes the expected or received secret value in the returned reason', () => {
    const result = verifyOrchestrationWebhookSecret({ [ORCHESTRATION_WEBHOOK_SECRET_HEADER]: 'wrong-value' }, CONFIG)
    expect(result.reason).not.toContain(CONFIG.customSecretValue)
    expect(result.reason).not.toContain('wrong-value')
  })
})

describe('verifyOrchestrationWebhookSignature (Layer 2 -- HMAC-SHA512 over exact raw body bytes)', () => {
  it('passes with a valid HMAC-SHA512 signature over the exact raw body', () => {
    const rawBody = JSON.stringify({ event_id: 'evt_1', event_type: 'payment_succeeded', content: { payment_id: 'p1', status: 'succeeded' }, timestamp: '2026-09-25T00:00:00Z' })
    const signature = sign(rawBody, CONFIG.paymentResponseHashKey)
    const result = verifyOrchestrationWebhookSignature(rawBody, { [ORCHESTRATION_WEBHOOK_SIGNATURE_HEADER]: signature }, CONFIG)
    expect(result.valid).toBe(true)
  })

  it('rejects an invalid HMAC', () => {
    const rawBody = JSON.stringify({ event_id: 'evt_1' })
    const result = verifyOrchestrationWebhookSignature(rawBody, { [ORCHESTRATION_WEBHOOK_SIGNATURE_HEADER]: 'a'.repeat(128) }, CONFIG)
    expect(result.valid).toBe(false)
  })

  it('rejects a malformed (non-hex) signature encoding', () => {
    const rawBody = JSON.stringify({ event_id: 'evt_1' })
    const result = verifyOrchestrationWebhookSignature(rawBody, { [ORCHESTRATION_WEBHOOK_SIGNATURE_HEADER]: 'not-hex-!!!' }, CONFIG)
    expect(result.valid).toBe(false)
  })

  it('rejects a missing signature header', () => {
    const rawBody = JSON.stringify({ event_id: 'evt_1' })
    const result = verifyOrchestrationWebhookSignature(rawBody, {}, CONFIG)
    expect(result.valid).toBe(false)
  })

  it('fails when the body changes by a single byte after signing', () => {
    const rawBody = JSON.stringify({ event_id: 'evt_1', amount: 100 })
    const signature = sign(rawBody, CONFIG.paymentResponseHashKey)
    const tamperedBody = JSON.stringify({ event_id: 'evt_1', amount: 101 })
    const result = verifyOrchestrationWebhookSignature(tamperedBody, { [ORCHESTRATION_WEBHOOK_SIGNATURE_HEADER]: signature }, CONFIG)
    expect(result.valid).toBe(false)
  })

  it('fails when the same JSON is reserialized with different key order/whitespace, even though logically equivalent -- signing operates on exact raw bytes, never a re-parsed object', () => {
    const original = '{"event_id":"evt_1","event_type":"payment_succeeded"}'
    const reserialized = JSON.stringify(JSON.parse(original), null, 2)
    expect(reserialized).not.toBe(original)
    const signature = sign(original, CONFIG.paymentResponseHashKey)
    const result = verifyOrchestrationWebhookSignature(reserialized, { [ORCHESTRATION_WEBHOOK_SIGNATURE_HEADER]: signature }, CONFIG)
    expect(result.valid).toBe(false)
  })

  it('accepts an uppercase-hex signature (case-insensitive comparison)', () => {
    const rawBody = JSON.stringify({ event_id: 'evt_1' })
    const signature = sign(rawBody, CONFIG.paymentResponseHashKey).toUpperCase()
    const result = verifyOrchestrationWebhookSignature(rawBody, { [ORCHESTRATION_WEBHOOK_SIGNATURE_HEADER]: signature }, CONFIG)
    expect(result.valid).toBe(true)
  })

  it('never includes the hash key or the raw signature value in the returned reason', () => {
    const rawBody = JSON.stringify({ event_id: 'evt_1' })
    const result = verifyOrchestrationWebhookSignature(rawBody, { [ORCHESTRATION_WEBHOOK_SIGNATURE_HEADER]: 'deadbeef' }, CONFIG)
    expect(result.reason).not.toContain(CONFIG.paymentResponseHashKey)
    expect(result.reason).not.toContain('deadbeef')
  })
})

describe('verifyOrchestrationWebhook (both layers required, no weak fallback)', () => {
  it('accepts only when both Layer 1 and Layer 2 pass', () => {
    const rawBody = JSON.stringify({ event_id: 'evt_1' })
    const signature = sign(rawBody, CONFIG.paymentResponseHashKey)
    const result = verifyOrchestrationWebhook(
      rawBody,
      { [ORCHESTRATION_WEBHOOK_SECRET_HEADER]: CONFIG.customSecretValue, [ORCHESTRATION_WEBHOOK_SIGNATURE_HEADER]: signature },
      CONFIG
    )
    expect(result.valid).toBe(true)
  })

  it('rejects when Layer 1 passes but Layer 2 fails', () => {
    const rawBody = JSON.stringify({ event_id: 'evt_1' })
    const result = verifyOrchestrationWebhook(
      rawBody,
      { [ORCHESTRATION_WEBHOOK_SECRET_HEADER]: CONFIG.customSecretValue, [ORCHESTRATION_WEBHOOK_SIGNATURE_HEADER]: 'wrong' },
      CONFIG
    )
    expect(result.valid).toBe(false)
  })

  it('rejects when Layer 2 would pass but Layer 1 fails -- no fallback to signature-only', () => {
    const rawBody = JSON.stringify({ event_id: 'evt_1' })
    const signature = sign(rawBody, CONFIG.paymentResponseHashKey)
    const result = verifyOrchestrationWebhook(rawBody, { [ORCHESTRATION_WEBHOOK_SIGNATURE_HEADER]: signature }, CONFIG)
    expect(result.valid).toBe(false)
  })

  it('rejects when both layers fail', () => {
    const result = verifyOrchestrationWebhook('{}', {}, CONFIG)
    expect(result.valid).toBe(false)
  })
})
