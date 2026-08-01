import { describe, it, expect } from 'vitest'
import { normalizeCheckoutWebhookPayload, normalizeOppwaWebhookPayload, normalizePayoutWebhookPayload } from '../event-normalizer'

describe('normalizeCheckoutWebhookPayload', () => {
  it('normalizes a well-formed Checkout webhook payload', () => {
    const result = normalizeCheckoutWebhookPayload({
      id: 'txn_1',
      merchantTransactionId: 'unity-b1-rental',
      type: 'Successful',
      result: { code: '000.000.000' },
    })
    expect(result).toEqual({
      source: 'checkout',
      peachTransactionId: 'txn_1',
      merchantTransactionId: 'unity-b1-rental',
      eventType: 'Successful',
      resultCode: '000.000.000',
    })
  })

  it('returns null when required fields are missing', () => {
    expect(normalizeCheckoutWebhookPayload({ type: 'Successful' })).toBeNull()
    expect(normalizeCheckoutWebhookPayload(null)).toBeNull()
    expect(normalizeCheckoutWebhookPayload('not an object')).toBeNull()
  })
})

describe('normalizeOppwaWebhookPayload', () => {
  it('normalizes a well-formed decrypted OPPWA payment payload, folding paymentType into eventType', () => {
    const result = normalizeOppwaWebhookPayload({
      type: 'PAYMENT',
      payload: { id: 'txn_2', merchantTransactionId: 'unity-b1-deposit', paymentType: 'CP', result: { code: '000.000.000' } },
    })
    expect(result).toEqual({
      source: 'oppwa',
      peachTransactionId: 'txn_2',
      merchantTransactionId: 'unity-b1-deposit',
      eventType: 'PAYMENT:CP',
      resultCode: '000.000.000',
    })
  })

  it('returns null when the inner payload id is missing', () => {
    expect(normalizeOppwaWebhookPayload({ type: 'PAYMENT', payload: {} })).toBeNull()
  })
})

describe('normalizePayoutWebhookPayload', () => {
  it('normalizes a well-formed payout status webhook', () => {
    const result = normalizePayoutWebhookPayload({ payoutId: 'po_1', status: 'successful', resultCode: '2900.000.000' })
    expect(result).toEqual({
      source: 'payouts',
      peachTransactionId: 'po_1',
      merchantTransactionId: null,
      eventType: 'payout:successful',
      resultCode: '2900.000.000',
    })
  })

  it('returns null when payoutId or status is missing', () => {
    expect(normalizePayoutWebhookPayload({ status: 'successful' })).toBeNull()
    expect(normalizePayoutWebhookPayload({ payoutId: 'po_1' })).toBeNull()
  })
})
