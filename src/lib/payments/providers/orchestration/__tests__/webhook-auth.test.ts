import { describe, it, expect } from 'vitest'
import { createHmac } from 'crypto'
import { NextRequest } from 'next/server'
import { verifyOrchestrationWebhookSecret, verifyOrchestrationWebhookSignature, verifyOrchestrationWebhook } from '../webhook-auth'
import { ORCHESTRATION_WEBHOOK_SECRET_HEADER, ORCHESTRATION_WEBHOOK_SIGNATURE_HEADER, type OrchestrationWebhookConfig } from '../webhook-config'
import { readBoundedRequestBody, ORCHESTRATION_WEBHOOK_BODY_LIMIT_BYTES } from '../../../webhook-body-reader'

const CONFIG: OrchestrationWebhookConfig = {
  customSecretHeaderName: ORCHESTRATION_WEBHOOK_SECRET_HEADER,
  customSecretValue: 'a-high-entropy-custom-secret-value',
  paymentResponseHashKey: 'a-high-entropy-payment-response-hash-key',
}

function sign(bodyBytes: Buffer, key: string): string {
  return createHmac('sha512', key).update(bodyBytes).digest('hex')
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
  it('passes with a valid HMAC-SHA512 signature over the exact raw body bytes', () => {
    const rawBody = Buffer.from(
      JSON.stringify({ event_id: 'evt_1', event_type: 'payment_succeeded', content: { payment_id: 'p1', status: 'succeeded' }, timestamp: '2026-09-25T00:00:00Z' }),
      'utf-8'
    )
    const signature = sign(rawBody, CONFIG.paymentResponseHashKey)
    const result = verifyOrchestrationWebhookSignature(rawBody, { [ORCHESTRATION_WEBHOOK_SIGNATURE_HEADER]: signature }, CONFIG)
    expect(result.valid).toBe(true)
  })

  it('rejects an invalid HMAC', () => {
    const rawBody = Buffer.from(JSON.stringify({ event_id: 'evt_1' }), 'utf-8')
    const result = verifyOrchestrationWebhookSignature(rawBody, { [ORCHESTRATION_WEBHOOK_SIGNATURE_HEADER]: 'a'.repeat(128) }, CONFIG)
    expect(result.valid).toBe(false)
  })

  it('rejects a malformed (non-hex) signature encoding', () => {
    const rawBody = Buffer.from(JSON.stringify({ event_id: 'evt_1' }), 'utf-8')
    const result = verifyOrchestrationWebhookSignature(rawBody, { [ORCHESTRATION_WEBHOOK_SIGNATURE_HEADER]: 'not-hex-!!!' }, CONFIG)
    expect(result.valid).toBe(false)
  })

  it('rejects a missing signature header', () => {
    const rawBody = Buffer.from(JSON.stringify({ event_id: 'evt_1' }), 'utf-8')
    const result = verifyOrchestrationWebhookSignature(rawBody, {}, CONFIG)
    expect(result.valid).toBe(false)
  })

  it('fails when the body changes by a single byte after signing', () => {
    const rawBody = Buffer.from(JSON.stringify({ event_id: 'evt_1', amount: 100 }), 'utf-8')
    const signature = sign(rawBody, CONFIG.paymentResponseHashKey)
    const tamperedBody = Buffer.from(JSON.stringify({ event_id: 'evt_1', amount: 101 }), 'utf-8')
    const result = verifyOrchestrationWebhookSignature(tamperedBody, { [ORCHESTRATION_WEBHOOK_SIGNATURE_HEADER]: signature }, CONFIG)
    expect(result.valid).toBe(false)
  })

  it('fails when the same JSON is reserialized with different key order/whitespace, even though logically equivalent -- signing operates on exact raw bytes, never a re-parsed object', () => {
    const original = Buffer.from('{"event_id":"evt_1","event_type":"payment_succeeded"}', 'utf-8')
    const reserialized = Buffer.from(JSON.stringify(JSON.parse(original.toString('utf-8')), null, 2), 'utf-8')
    expect(Buffer.compare(original, reserialized)).not.toBe(0)
    const signature = sign(original, CONFIG.paymentResponseHashKey)
    const result = verifyOrchestrationWebhookSignature(reserialized, { [ORCHESTRATION_WEBHOOK_SIGNATURE_HEADER]: signature }, CONFIG)
    expect(result.valid).toBe(false)
  })

  it('accepts an uppercase-hex signature (case-insensitive comparison)', () => {
    const rawBody = Buffer.from(JSON.stringify({ event_id: 'evt_1' }), 'utf-8')
    const signature = sign(rawBody, CONFIG.paymentResponseHashKey).toUpperCase()
    const result = verifyOrchestrationWebhookSignature(rawBody, { [ORCHESTRATION_WEBHOOK_SIGNATURE_HEADER]: signature }, CONFIG)
    expect(result.valid).toBe(true)
  })

  it('never includes the hash key or the raw signature value in the returned reason', () => {
    const rawBody = Buffer.from(JSON.stringify({ event_id: 'evt_1' }), 'utf-8')
    const result = verifyOrchestrationWebhookSignature(rawBody, { [ORCHESTRATION_WEBHOOK_SIGNATURE_HEADER]: 'deadbeef' }, CONFIG)
    expect(result.reason).not.toContain(CONFIG.paymentResponseHashKey)
    expect(result.reason).not.toContain('deadbeef')
  })

  it('P5D-B.1: HMAC succeeds over a byte sequence containing INVALID UTF-8, signed exactly as received -- proves the verifier never decodes/re-encodes before hashing', () => {
    // A byte sequence that is NOT valid UTF-8 (a lone continuation byte,
    // 0x80) embedded inside an otherwise JSON-shaped body. If the
    // verifier decoded this to a string and re-encoded it before
    // hashing (the P5D-B defect), the lossy round-trip would produce
    // different bytes than what was actually signed, and this
    // signature -- computed over the true original bytes -- would fail
    // to verify. It must NOT fail.
    const rawBody = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0x80, 0x22, 0x7d]) // {"a":"<0x80>"}
    // Confirm this really is invalid UTF-8 (the premise of the test).
    expect(Buffer.compare(Buffer.from(rawBody.toString('utf-8'), 'utf-8'), rawBody)).not.toBe(0)
    const signature = sign(rawBody, CONFIG.paymentResponseHashKey)
    const result = verifyOrchestrationWebhookSignature(rawBody, { [ORCHESTRATION_WEBHOOK_SIGNATURE_HEADER]: signature }, CONFIG)
    expect(result.valid).toBe(true)
  })

  it('P5D-B.1: a signature computed over the LOSSY decode/re-encode of invalid-UTF-8 bytes does NOT stand in for the signature over the true original bytes', () => {
    const rawBody = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0x80, 0x22, 0x7d])
    const lossyRoundTrip = Buffer.from(rawBody.toString('utf-8'), 'utf-8')
    const signatureOverLossyBytes = sign(lossyRoundTrip, CONFIG.paymentResponseHashKey)
    // Verifying the TRUE original bytes against a signature computed
    // over the LOSSY (replacement-character) bytes must fail -- they
    // are genuinely different byte sequences.
    const result = verifyOrchestrationWebhookSignature(rawBody, { [ORCHESTRATION_WEBHOOK_SIGNATURE_HEADER]: signatureOverLossyBytes }, CONFIG)
    expect(result.valid).toBe(false)
  })
})

describe('verifyOrchestrationWebhook (both layers required, no weak fallback)', () => {
  it('accepts only when both Layer 1 and Layer 2 pass', () => {
    const rawBody = Buffer.from(JSON.stringify({ event_id: 'evt_1' }), 'utf-8')
    const signature = sign(rawBody, CONFIG.paymentResponseHashKey)
    const result = verifyOrchestrationWebhook(
      rawBody,
      { [ORCHESTRATION_WEBHOOK_SECRET_HEADER]: CONFIG.customSecretValue, [ORCHESTRATION_WEBHOOK_SIGNATURE_HEADER]: signature },
      CONFIG
    )
    expect(result.valid).toBe(true)
  })

  it('rejects when Layer 1 passes but Layer 2 fails', () => {
    const rawBody = Buffer.from(JSON.stringify({ event_id: 'evt_1' }), 'utf-8')
    const result = verifyOrchestrationWebhook(
      rawBody,
      { [ORCHESTRATION_WEBHOOK_SECRET_HEADER]: CONFIG.customSecretValue, [ORCHESTRATION_WEBHOOK_SIGNATURE_HEADER]: 'wrong' },
      CONFIG
    )
    expect(result.valid).toBe(false)
  })

  it('rejects when Layer 2 would pass but Layer 1 fails -- no fallback to signature-only', () => {
    const rawBody = Buffer.from(JSON.stringify({ event_id: 'evt_1' }), 'utf-8')
    const signature = sign(rawBody, CONFIG.paymentResponseHashKey)
    const result = verifyOrchestrationWebhook(rawBody, { [ORCHESTRATION_WEBHOOK_SIGNATURE_HEADER]: signature }, CONFIG)
    expect(result.valid).toBe(false)
  })

  it('rejects when both layers fail', () => {
    const result = verifyOrchestrationWebhook(Buffer.from('{}', 'utf-8'), {}, CONFIG)
    expect(result.valid).toBe(false)
  })
})

describe('P5D-B.1: upstream reader/verifier integration (not merely the HMAC helper in isolation)', () => {
  function requestWithRawBytes(bytes: Buffer, extraHeaders: Record<string, string> = {}): NextRequest {
    return new NextRequest('https://unity.test/api/payments/webhooks/peach', {
      method: 'POST',
      body: new Uint8Array(bytes),
      headers: { 'content-type': 'application/json', ...extraHeaders },
    })
  }

  it('A. valid normal UTF-8 JSON read through readBoundedRequestBody, then a valid HMAC over those exact bytes -> accepted', async () => {
    const original = Buffer.from(JSON.stringify({ event_id: 'evt_1', content: { payment_id: 'p1', status: 'succeeded' } }), 'utf-8')
    const signature = sign(original, CONFIG.paymentResponseHashKey)
    const readResult = await readBoundedRequestBody(requestWithRawBytes(original), ORCHESTRATION_WEBHOOK_BODY_LIMIT_BYTES)
    expect(readResult.ok).toBe(true)
    if (!readResult.ok) throw new Error('unreachable')
    const authResult = verifyOrchestrationWebhookSignature(readResult.bytes, { [ORCHESTRATION_WEBHOOK_SIGNATURE_HEADER]: signature }, CONFIG)
    expect(authResult.valid).toBe(true)
  })

  it('D. a body containing an invalid UTF-8 byte sequence, with a VALID HMAC computed over those exact original bytes: Layer 2 succeeds through the real reader, and original bytes are never silently changed before HMAC', async () => {
    const original = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0x80, 0x22, 0x7d]) // invalid UTF-8
    const signature = sign(original, CONFIG.paymentResponseHashKey)
    const readResult = await readBoundedRequestBody(requestWithRawBytes(original), ORCHESTRATION_WEBHOOK_BODY_LIMIT_BYTES)
    expect(readResult.ok).toBe(true)
    if (!readResult.ok) throw new Error('unreachable')
    // The reader must hand back the EXACT original bytes, unchanged.
    expect(Buffer.compare(readResult.bytes, original)).toBe(0)
    const authResult = verifyOrchestrationWebhookSignature(readResult.bytes, { [ORCHESTRATION_WEBHOOK_SIGNATURE_HEADER]: signature }, CONFIG)
    expect(authResult.valid).toBe(true)
    // Subsequent strict UTF-8 decoding (what the route does only AFTER
    // auth succeeds) must then reject this body as malformed.
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(readResult.bytes)).toThrow()
  })
})
