import { describe, it, expect } from 'vitest'
import {
  extractRedirectUrl,
  parseCreateHostedCheckoutPaymentResponse,
  parseCapturePaymentResponse,
  parseCancelPaymentResponse,
  parseGetPaymentResponse,
  UnrecognizedOrchestrationResponseError,
} from '../response-parsers'

describe('extractRedirectUrl (unconfirmed response field -- defensive, never a silent guess)', () => {
  it('accepts each of the plausible candidate field names', () => {
    expect(extractRedirectUrl({ redirect_url: 'https://secure.example/1' })).toBe('https://secure.example/1')
    expect(extractRedirectUrl({ checkout_url: 'https://secure.example/2' })).toBe('https://secure.example/2')
    expect(extractRedirectUrl({ hosted_checkout_url: 'https://secure.example/3' })).toBe('https://secure.example/3')
    expect(extractRedirectUrl({ url: 'https://secure.example/4' })).toBe('https://secure.example/4')
  })

  it('throws a distinctive, clear error when none of the candidate fields are present -- never returns undefined/empty as if valid', () => {
    expect(() => extractRedirectUrl({ payment_id: 'p_1', status: 'requires_confirmation' })).toThrow(UnrecognizedOrchestrationResponseError)
  })

  it('ignores a candidate field that is present but not a non-empty string', () => {
    expect(() => extractRedirectUrl({ redirect_url: '', url: 123 })).toThrow(UnrecognizedOrchestrationResponseError)
  })
})

describe('extractRedirectUrl (P5D-B: documented nested next_action shape)', () => {
  it('prefers next_action.redirect_to_url when next_action.type is "redirect_to_url"', () => {
    const result = extractRedirectUrl({
      payment_id: 'p_1',
      status: 'requires_customer_action',
      next_action: { type: 'redirect_to_url', redirect_to_url: 'https://app.sandbox-next.peachpayments.com/api/payments/redirect/pay_1' },
    })
    expect(result).toBe('https://app.sandbox-next.peachpayments.com/api/payments/redirect/pay_1')
  })

  it('never lets a top-level fallback field override a present next_action', () => {
    const result = extractRedirectUrl({
      next_action: { type: 'redirect_to_url', redirect_to_url: 'https://correct.example/nested' },
      url: 'https://wrong.example/top-level-should-be-ignored',
    })
    expect(result).toBe('https://correct.example/nested')
  })

  it('rejects an unsupported next_action.type explicitly, never silently falling through to a guessed field', () => {
    expect(() =>
      extractRedirectUrl({ next_action: { type: 'three_ds_invoke', three_ds_data: {} }, url: 'https://should-not-be-used.example' })
    ).toThrow(UnrecognizedOrchestrationResponseError)
    expect(() => extractRedirectUrl({ next_action: { type: 'invoke_hidden_iframe', iframe_data: {} } })).toThrow(UnrecognizedOrchestrationResponseError)
    expect(() => extractRedirectUrl({ next_action: { type: 'redirect_inside_popup', popup_url: 'https://x' } })).toThrow(UnrecognizedOrchestrationResponseError)
  })

  it('rejects a redirect_to_url next_action with a missing/empty redirect_to_url field, rather than returning an empty string', () => {
    expect(() => extractRedirectUrl({ next_action: { type: 'redirect_to_url' } })).toThrow(UnrecognizedOrchestrationResponseError)
    expect(() => extractRedirectUrl({ next_action: { type: 'redirect_to_url', redirect_to_url: '' } })).toThrow(UnrecognizedOrchestrationResponseError)
  })

  it('falls back to the top-level candidate fields only when next_action is entirely absent', () => {
    expect(extractRedirectUrl({ redirect_url: 'https://legacy.example/1' })).toBe('https://legacy.example/1')
  })

  it('does not treat a malformed next_action (no string type) as a next_action -- falls through to the top-level candidates instead', () => {
    expect(extractRedirectUrl({ next_action: { redirect_to_url: 'https://ignored.example' }, url: 'https://fallback.example' })).toBe('https://fallback.example')
  })
})

describe('parseCreateHostedCheckoutPaymentResponse', () => {
  it('parses a well-formed response', () => {
    const result = parseCreateHostedCheckoutPaymentResponse({ payment_id: 'p_1', status: 'requires_confirmation', redirect_url: 'https://secure.example/x' })
    expect(result.payment_id).toBe('p_1')
    expect(result.status).toBe('requires_confirmation')
  })

  it('rejects a non-object body', () => {
    expect(() => parseCreateHostedCheckoutPaymentResponse(null)).toThrow(UnrecognizedOrchestrationResponseError)
    expect(() => parseCreateHostedCheckoutPaymentResponse('a string')).toThrow(UnrecognizedOrchestrationResponseError)
  })

  it('rejects a body missing payment_id', () => {
    expect(() => parseCreateHostedCheckoutPaymentResponse({ status: 'requires_confirmation' })).toThrow(UnrecognizedOrchestrationResponseError)
  })

  it('rejects a body missing status', () => {
    expect(() => parseCreateHostedCheckoutPaymentResponse({ payment_id: 'p_1' })).toThrow(UnrecognizedOrchestrationResponseError)
  })
})

describe('parseCapturePaymentResponse / parseCancelPaymentResponse', () => {
  it('parse a well-formed capture response', () => {
    expect(parseCapturePaymentResponse({ payment_id: 'p_1', status: 'succeeded' })).toEqual({ payment_id: 'p_1', status: 'succeeded' })
  })

  it('parse a well-formed cancel response', () => {
    expect(parseCancelPaymentResponse({ payment_id: 'p_1', status: 'cancelled' })).toEqual({ payment_id: 'p_1', status: 'cancelled' })
  })

  it('reject malformed bodies', () => {
    expect(() => parseCapturePaymentResponse({})).toThrow(UnrecognizedOrchestrationResponseError)
    expect(() => parseCancelPaymentResponse({})).toThrow(UnrecognizedOrchestrationResponseError)
  })
})

describe('parseGetPaymentResponse', () => {
  it('parses a well-formed response including amount/currency', () => {
    const result = parseGetPaymentResponse({ payment_id: 'p_1', status: 'succeeded', amount: 9200, currency: 'ZAR' })
    expect(result).toEqual({ payment_id: 'p_1', status: 'succeeded', amount: 9200, currency: 'ZAR' })
  })

  it('rejects a non-numeric amount', () => {
    expect(() => parseGetPaymentResponse({ payment_id: 'p_1', status: 'succeeded', amount: '9200', currency: 'ZAR' })).toThrow(UnrecognizedOrchestrationResponseError)
  })

  it('rejects a missing currency', () => {
    expect(() => parseGetPaymentResponse({ payment_id: 'p_1', status: 'succeeded', amount: 9200 })).toThrow(UnrecognizedOrchestrationResponseError)
  })
})
