import { describe, it, expect } from 'vitest'
import { deriveOrderFinancialReadiness, deriveDeliveryMethodHint, ORDER_CSV_COLUMNS, getAdminOrderDetail } from '../orders-service'

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

/**
 * D3-D: getAdminOrderDetail real-data scope. listAdminOrders' own list
 * RPC (_admin_list_orders_page) cannot be safely extended with a real-
 * data filter without a new migration (editing a CREATE OR REPLACE
 * FUNCTION body is itself a migration, and this phase creates none) --
 * reported as a blocker in the final report, not worked around here.
 * getAdminOrderDetail is a plain table query with no such constraint,
 * so it is scoped directly.
 */
function fakeOrderDetailAdmin(orderRow: Record<string, unknown> | null, profileRows: Record<string, unknown>[]) {
  const orderQuery: Record<string, unknown> = {}
  for (const method of ['select', 'eq']) orderQuery[method] = () => orderQuery
  orderQuery.maybeSingle = () => Promise.resolve({ data: orderRow, error: null })

  const profilesQuery: Record<string, unknown> = {}
  for (const method of ['select', 'in']) profilesQuery[method] = () => profilesQuery
  profilesQuery.then = (resolve: (v: { data: typeof profileRows; error: null }) => void) => resolve({ data: profileRows, error: null })

  const empty: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'order']) empty[method] = () => empty
  empty.then = (resolve: (v: { data: unknown[]; error: null }) => void) => resolve({ data: [], error: null })
  empty.maybeSingle = () => Promise.resolve({ data: null, error: null })

  return {
    from: (table: string) => {
      if (table === 'orders') return orderQuery
      if (table === 'profiles') return profilesQuery
      return empty
    },
  } as unknown as Parameters<typeof getAdminOrderDetail>[0]
}

describe('orders-service: getAdminOrderDetail real-data scope (category: ADMIN-CONTROL-CENTRE-BATCH-D3-D)', () => {
  const baseOrder = {
    id: 'o1', order_reference: 'ORD-1', listing_id: 'l1', buyer_id: 'buy1', seller_id: 'sell1',
    status: 'paid', quantity: 1, unit_price: 100, shipping_fee: 0, total_amount: 100, created_at: '2026-01-01T00:00:00Z',
  }

  it('12. real buyer + real seller resolves normally -- orders has no is_test column of its own', async () => {
    const admin = fakeOrderDetailAdmin(baseOrder, [
      { id: 'buy1', full_name: 'Buyer', display_name: null, account_status: 'active', kyc_status: 'approved', data_classification: 'real' },
      { id: 'sell1', full_name: 'Seller', display_name: null, account_status: 'active', kyc_status: 'approved', data_classification: 'real' },
    ])
    const detail = await getAdminOrderDetail(admin, 'o1')
    expect(detail).not.toBeNull()
  })

  it('13. a test-classified seller blocks the order even though the buyer is real', async () => {
    const admin = fakeOrderDetailAdmin(baseOrder, [
      { id: 'buy1', full_name: 'Buyer', display_name: null, account_status: 'active', kyc_status: 'approved', data_classification: 'real' },
      { id: 'sell1', full_name: 'Seller', display_name: null, account_status: 'active', kyc_status: 'approved', data_classification: 'test' },
    ])
    const detail = await getAdminOrderDetail(admin, 'o1')
    expect(detail).toBeNull()
  })

  it('14. an unknown-classified buyer blocks the order', async () => {
    const admin = fakeOrderDetailAdmin(baseOrder, [
      { id: 'buy1', full_name: 'Buyer', display_name: null, account_status: 'active', kyc_status: 'approved', data_classification: 'unknown' },
      { id: 'sell1', full_name: 'Seller', display_name: null, account_status: 'active', kyc_status: 'approved', data_classification: 'real' },
    ])
    const detail = await getAdminOrderDetail(admin, 'o1')
    expect(detail).toBeNull()
  })

  it('15. a missing order row returns null', async () => {
    const admin = fakeOrderDetailAdmin(null, [])
    const detail = await getAdminOrderDetail(admin, 'missing')
    expect(detail).toBeNull()
  })
})
