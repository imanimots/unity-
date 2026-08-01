import { describe, it, expect } from 'vitest'
import {
  computeCreatePaymentIntentHash,
  computeTransitionPaymentStatusHash,
  computeCreateRefundHash,
  computeCreateMerchantPayoutHash,
} from '../idempotency'

describe('computeCreatePaymentIntentHash', () => {
  it('matches the exact md5 Postgres produces for the same inputs', () => {
    // select md5(booking_id || '|' || payment_type || '|' || amount::text || '|' || currency || '|' || provider)
    const hash = computeCreatePaymentIntentHash('b1', 'deposit', 500, 'ZAR', 'mock')
    expect(hash).toBe('ac95715631c49f711d356236ce83fb73')
  })

  it('produces a different hash for a different amount', () => {
    const a = computeCreatePaymentIntentHash('b1', 'deposit', 500, 'ZAR', 'mock')
    const b = computeCreatePaymentIntentHash('b1', 'deposit', 600, 'ZAR', 'mock')
    expect(a).not.toBe(b)
  })
})

describe('computeTransitionPaymentStatusHash', () => {
  it('matches the exact md5 Postgres produces for the same inputs', () => {
    // select md5(payment_id || '|' || new_status || '|' || provider_reference || '|' || failure_reason)
    const hash = computeTransitionPaymentStatusHash('p1', 'captured', 'ref-123', undefined)
    expect(hash).toBe('8d42bd7a069d712453faffa86f59af6c')
  })

  it('treats null and undefined the same way as an empty string', () => {
    const a = computeTransitionPaymentStatusHash('p1', 'captured', 'ref-123', null)
    const b = computeTransitionPaymentStatusHash('p1', 'captured', 'ref-123', undefined)
    expect(a).toBe(b)
  })
})

describe('computeCreateRefundHash', () => {
  it('matches the exact md5 Postgres produces for the same inputs', () => {
    // select md5(payment_id || '|' || amount::text || '|' || reason)
    const hash = computeCreateRefundHash('p1', 250.5, 'damaged item')
    expect(hash).toBe('319dab54183e362be2c81641b40f6054')
  })
})

describe('computeCreateMerchantPayoutHash', () => {
  it('matches the exact md5 Postgres produces for the same inputs', () => {
    // select md5(merchant_id || '|' || booking_id || '|' || amount::text)
    const hash = computeCreateMerchantPayoutHash('m1', 'b1', 712.5)
    expect(hash).toBe('78cc2ba9203667da64bbc0719707ab57')
  })
})
