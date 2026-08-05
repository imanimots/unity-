import { describe, it, expect } from 'vitest'
import { deriveOrderFinancialReadiness, deriveDeliveryMethodHint, ORDER_CSV_COLUMNS } from '../orders-service'

describe('orders-service: deriveOrderFinancialReadiness (category: Financial)', () => {
  it('1. a pending order with a failed payment is payment_failed', () => {
    expect(deriveOrderFinancialReadiness('pending', 'failed')).toBe('payment_failed')
  })
  it('2. a pending order with no payment yet is awaiting_payment', () => {
    expect(deriveOrderFinancialReadiness('pending', null)).toBe('awaiting_payment')
  })
  it('3. a paid order is financially_ready', () => {
    expect(deriveOrderFinancialReadiness('paid', 'captured')).toBe('financially_ready')
  })
  it('4. a shipped order is financially_ready', () => {
    expect(deriveOrderFinancialReadiness('shipped', 'captured')).toBe('financially_ready')
  })
  it('5. a delivered order is financially_ready', () => {
    expect(deriveOrderFinancialReadiness('delivered', 'captured')).toBe('financially_ready')
  })
})

describe('orders-service: deriveDeliveryMethodHint -- a listing-level capability hint, never a per-order recorded choice (category: Financial)', () => {
  it('6. a listing offering merchant delivery is labeled accordingly', () => {
    expect(deriveDeliveryMethodHint({ shipping_payer: 'seller', delivery_available: true, merchant_delivery_available: true })).toBe('merchant delivery available')
  })
  it('7. a listing offering plain delivery (not merchant-specific) is labeled accordingly', () => {
    expect(deriveDeliveryMethodHint({ shipping_payer: 'buyer', delivery_available: true, merchant_delivery_available: false })).toBe('delivery available')
  })
  it('8. a listing with neither flag falls back to a neutral label, not a fabricated method', () => {
    expect(deriveDeliveryMethodHint({ shipping_payer: null, delivery_available: false, merchant_delivery_available: false })).toBe('collection / shipping not specified')
  })
  it('9. a missing listing (deleted/unavailable) is "unknown", never silently blank', () => {
    expect(deriveDeliveryMethodHint(null)).toBe('unknown')
  })
})

describe('orders-service: CSV export column list (category: CSV Exports)', () => {
  it('10. excludes email, KYC document fields, provider payloads, and banking details', () => {
    const forbidden = ['email', 'kyc', 'document', 'provider', 'bank', 'card', 'secret', 'token']
    for (const col of ORDER_CSV_COLUMNS) {
      const lower = col.toLowerCase()
      for (const f of forbidden) {
        expect(lower.includes(f), `column "${col}" should not include "${f}"`).toBe(false)
      }
    }
  })
  it('11. includes the buyer/seller name columns (participant identity), not raw user ids', () => {
    expect(ORDER_CSV_COLUMNS).toContain('buyerName')
    expect(ORDER_CSV_COLUMNS).toContain('sellerName')
  })
})
