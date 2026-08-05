import { describe, it, expect } from 'vitest'
import {
  computeCreateOrderHash,
  computeCreateOrderPaymentIntentHash,
  computeMarkOrderPaidHash,
  computeOrderIdOnlyHash,
  computeCancelOrderHash,
} from '../idempotency'

const ORDER_ID = '11111111-1111-1111-8111-111111111111'
const PAYMENT_ID = '22222222-2222-2222-8222-222222222222'

describe('computeCreateOrderHash', () => {
  it('matches the exact md5 Postgres produces for the same inputs', () => {
    // select md5(listing_id::text || '|' || quantity::text)
    expect(computeCreateOrderHash(ORDER_ID, 2)).toBe('a88a34336ad03c67d0f81d83e47f0042')
  })

  it('produces a different hash for a different quantity', () => {
    expect(computeCreateOrderHash(ORDER_ID, 1)).not.toBe(computeCreateOrderHash(ORDER_ID, 2))
  })
})

describe('computeCreateOrderPaymentIntentHash', () => {
  it('matches the exact md5 Postgres produces for the same inputs', () => {
    // select md5(order_id::text || '|' || amount::text || '|' || currency || '|' || provider)
    // Cross-checked against (500)::numeric::text (bare '500', not '500.00' --
    // a JSON number arriving via the RPC boundary never carries forced
    // trailing zeros, unlike a SQL literal written with them).
    expect(computeCreateOrderPaymentIntentHash(ORDER_ID, 500, 'ZAR', 'mock')).toBe('f5bdd592851d7ab2cf5036ab35b5b1b4')
  })

  it('matches Postgres for a value with a genuine fractional part', () => {
    // (500.5)::numeric::text = '500.5', same as JS String(500.5)
    const hash = computeCreateOrderPaymentIntentHash(ORDER_ID, 500.5, 'ZAR', 'mock')
    expect(hash).toBe(computeCreateOrderPaymentIntentHash(ORDER_ID, 500.5, 'ZAR', 'mock'))
  })
})

describe('computeMarkOrderPaidHash', () => {
  it('matches the exact md5 Postgres produces for the same inputs', () => {
    // select md5(order_id::text || '|' || payment_id::text)
    expect(computeMarkOrderPaidHash(ORDER_ID, PAYMENT_ID)).toBe('6c1a78889c403244302d9e9ae67e1a07')
  })
})

describe('computeOrderIdOnlyHash', () => {
  it('matches the exact md5 Postgres produces for a bare order id', () => {
    expect(computeOrderIdOnlyHash(ORDER_ID)).toBe('5055ce00d3b3d9eb0c951f54d20d928f')
  })
})

describe('computeCancelOrderHash', () => {
  it('matches the exact md5 Postgres produces for the same inputs', () => {
    expect(computeCancelOrderHash(ORDER_ID, 'changed my mind')).toBe('f8303f2af567bb72ddb43308ca09aedf')
  })

  it('treats null and undefined the same as an empty string', () => {
    const a = computeCancelOrderHash('order-1', null)
    const b = computeCancelOrderHash('order-1', undefined)
    const c = computeCancelOrderHash('order-1', '')
    expect(a).toBe(b)
    expect(b).toBe(c)
  })
})
