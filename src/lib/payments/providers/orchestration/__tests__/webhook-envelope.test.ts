import { describe, it, expect } from 'vitest'
import { parseOrchestrationWebhookEnvelope, categorizeOrchestrationStatus, isRefundEventType, MalformedOrchestrationWebhookError } from '../webhook-envelope'

function envelope(overrides: Record<string, unknown> = {}, contentOverrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event_id: 'evt_1',
    event_type: 'payment_succeeded',
    timestamp: '2026-09-25T00:00:00Z',
    content: { payment_id: 'pay_1', status: 'succeeded', amount: 9200, currency: 'ZAR', ...contentOverrides },
    ...overrides,
  })
}

describe('parseOrchestrationWebhookEnvelope -- valid envelope', () => {
  it('parses a well-formed envelope', () => {
    const result = parseOrchestrationWebhookEnvelope(envelope())
    expect(result.eventId).toBe('evt_1')
    expect(result.eventType).toBe('payment_succeeded')
    expect(result.timestamp).toBe('2026-09-25T00:00:00Z')
    expect(result.content.paymentId).toBe('pay_1')
    expect(result.content.status).toBe('succeeded')
    expect(result.content.amountMinorUnits).toBe(9200)
    expect(result.content.currency).toBe('ZAR')
  })

  it('tolerates unknown top-level fields -- Peach adding a field later must not break parsing', () => {
    const result = parseOrchestrationWebhookEnvelope(envelope({ some_future_field: 'x', api_version: '2027-01-01' }))
    expect(result.eventId).toBe('evt_1')
  })

  it('tolerates unknown content fields', () => {
    const result = parseOrchestrationWebhookEnvelope(envelope({}, { some_future_content_field: true }))
    expect(result.content.paymentId).toBe('pay_1')
  })

  it('parses next_action when present', () => {
    const result = parseOrchestrationWebhookEnvelope(
      envelope({}, { status: 'requires_customer_action', next_action: { type: 'redirect_to_url', redirect_to_url: 'https://secure.example/x' } })
    )
    expect(result.content.nextAction).toEqual({ type: 'redirect_to_url', redirect_to_url: 'https://secure.example/x' })
  })

  it('leaves amount/currency/metadata/nextAction undefined when absent -- optional evidence stays optional, never defaulted', () => {
    const result = parseOrchestrationWebhookEnvelope(JSON.stringify({ event_id: 'evt_1', event_type: 'payment_created', content: { payment_id: 'p1', status: 'requires_payment_method' } }))
    expect(result.content.amountMinorUnits).toBeUndefined()
    expect(result.content.currency).toBeUndefined()
    expect(result.content.nextAction).toBeUndefined()
    expect(result.content.metadata).toBeUndefined()
  })

  it('parses metadata when present', () => {
    const result = parseOrchestrationWebhookEnvelope(envelope({}, { metadata: { unity_payment_id: 'abc-123' } }))
    expect(result.content.metadata).toEqual({ unity_payment_id: 'abc-123' })
  })
})

describe('parseOrchestrationWebhookEnvelope -- malformed envelope fails closed', () => {
  it('rejects invalid JSON', () => {
    expect(() => parseOrchestrationWebhookEnvelope('not json')).toThrow(MalformedOrchestrationWebhookError)
  })

  it('rejects a non-object JSON body', () => {
    expect(() => parseOrchestrationWebhookEnvelope('"just a string"')).toThrow(MalformedOrchestrationWebhookError)
    expect(() => parseOrchestrationWebhookEnvelope('42')).toThrow(MalformedOrchestrationWebhookError)
  })

  it('rejects a missing event_id', () => {
    expect(() => parseOrchestrationWebhookEnvelope(JSON.stringify({ event_type: 'payment_succeeded', content: { payment_id: 'p1', status: 'succeeded' } }))).toThrow(
      MalformedOrchestrationWebhookError
    )
  })

  it('rejects a missing event_type', () => {
    expect(() => parseOrchestrationWebhookEnvelope(JSON.stringify({ event_id: 'evt_1', content: { payment_id: 'p1', status: 'succeeded' } }))).toThrow(
      MalformedOrchestrationWebhookError
    )
  })

  it('rejects a missing content object', () => {
    expect(() => parseOrchestrationWebhookEnvelope(JSON.stringify({ event_id: 'evt_1', event_type: 'payment_succeeded' }))).toThrow(MalformedOrchestrationWebhookError)
  })

  it('rejects content missing payment_id', () => {
    expect(() =>
      parseOrchestrationWebhookEnvelope(JSON.stringify({ event_id: 'evt_1', event_type: 'payment_succeeded', content: { status: 'succeeded' } }))
    ).toThrow(MalformedOrchestrationWebhookError)
  })

  it('rejects content missing status', () => {
    expect(() =>
      parseOrchestrationWebhookEnvelope(JSON.stringify({ event_id: 'evt_1', event_type: 'payment_succeeded', content: { payment_id: 'p1' } }))
    ).toThrow(MalformedOrchestrationWebhookError)
  })

  it('missing timestamp does not fail the whole envelope -- it is optional evidence', () => {
    const result = parseOrchestrationWebhookEnvelope(JSON.stringify({ event_id: 'evt_1', event_type: 'payment_succeeded', content: { payment_id: 'p1', status: 'succeeded' } }))
    expect(result.timestamp).toBeUndefined()
  })
})

describe('categorizeOrchestrationStatus', () => {
  it('categorizes the five no-transition (pending-equivalent) statuses', () => {
    for (const status of ['requires_payment_method', 'requires_confirmation', 'requires_action', 'requires_customer_action', 'processing']) {
      expect(categorizeOrchestrationStatus(status)).toEqual({ kind: 'no_transition' })
    }
  })

  it('maps requires_capture -> authorised', () => {
    expect(categorizeOrchestrationStatus('requires_capture')).toEqual({ kind: 'target', target: 'authorised' })
  })

  it('maps succeeded -> captured', () => {
    expect(categorizeOrchestrationStatus('succeeded')).toEqual({ kind: 'target', target: 'captured' })
  })

  it('maps failed -> failed', () => {
    expect(categorizeOrchestrationStatus('failed')).toEqual({ kind: 'target', target: 'failed' })
  })

  it('maps partially_captured -> partially_captured', () => {
    expect(categorizeOrchestrationStatus('partially_captured')).toEqual({ kind: 'target', target: 'partially_captured' })
  })

  it('classifies cancelled as its own context-sensitive category, not a fixed target', () => {
    expect(categorizeOrchestrationStatus('cancelled')).toEqual({ kind: 'cancelled' })
  })

  it('classifies an unrecognized future status as unknown, never coerced to a known category', () => {
    expect(categorizeOrchestrationStatus('some_future_status')).toEqual({ kind: 'unknown', rawStatus: 'some_future_status' })
  })
})

describe('isRefundEventType', () => {
  it('recognizes refund_* event types', () => {
    expect(isRefundEventType('refund_succeeded')).toBe(true)
    expect(isRefundEventType('refund_created')).toBe(true)
    expect(isRefundEventType('refund_failed')).toBe(true)
  })

  it('does not classify a payment event as a refund event', () => {
    expect(isRefundEventType('payment_succeeded')).toBe(false)
    expect(isRefundEventType('dispute_opened')).toBe(false)
  })
})
