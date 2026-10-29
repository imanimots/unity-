import { describe, it, expect } from 'vitest'
import { listAdminEscrowTransactions, getAdminEscrowDetail, getRealEscrowOverviewCounts } from '../escrow-service'

function fakeTableData(tables: Record<string, Record<string, unknown>[]>) {
  return {
    from: (table: string) => {
      const rows = tables[table] ?? []
      let filters: Record<string, unknown> = {}
      const obj: Record<string, unknown> = {
        select: () => obj,
        eq: (col: string, val: unknown) => {
          filters = { ...filters, [col]: val }
          return obj
        },
        in: (col: string, vals: unknown[]) => {
          filters = { ...filters, [`__in_${col}`]: vals }
          return obj
        },
        not: () => obj,
        order: () => obj,
        maybeSingle: () => {
          const match = rows.find((r) =>
            Object.entries(filters).every(([k, v]) => (k.startsWith('__in_') ? (v as unknown[]).includes(r[k.replace('__in_', '')]) : r[k] === v))
          )
          return Promise.resolve({ data: match ?? null, error: null })
        },
        then: (resolve: (v: { data: Record<string, unknown>[]; error: null }) => void) => {
          const matched = rows.filter((r) =>
            Object.entries(filters).every(([k, v]) => (k.startsWith('__in_') ? (v as unknown[]).includes(r[k.replace('__in_', '')]) : r[k] === v))
          )
          resolve({ data: matched, error: null })
        },
      }
      return obj
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

describe('escrow-service: getAdminEscrowDetail real-data scope (category: ADMIN-CONTROL-CENTRE-BATCH-D3-E)', () => {
  it('1. an order-linked escrow requires buyer+seller real and the listing non-test', async () => {
    const admin = fakeTableData({
      escrow_transactions: [{ id: 'e1', order_id: 'o1', booking_id: null, barter_agreement_id: null }],
      orders: [{ id: 'o1', buyer_id: 'b1', seller_id: 's1', listing_id: 'l1' }],
      listings: [{ id: 'l1', is_test: false }],
      profiles: [{ id: 'b1', data_classification: 'real' }, { id: 's1', data_classification: 'real' }],
      disputes: [],
    })
    expect(await getAdminEscrowDetail(admin, 'e1')).not.toBeNull()
  })

  it('2. a booking-linked escrow is excluded when the merchant is unknown even though the renter is real', async () => {
    const admin = fakeTableData({
      escrow_transactions: [{ id: 'e2', order_id: null, booking_id: 'bk1', barter_agreement_id: null }],
      bookings: [{ id: 'bk1', renter_id: 'r1', merchant_id: 'm1', listing_id: 'l2' }],
      listings: [{ id: 'l2', is_test: false }],
      profiles: [{ id: 'r1', data_classification: 'real' }, { id: 'm1', data_classification: 'unknown' }],
      disputes: [],
    })
    expect(await getAdminEscrowDetail(admin, 'e2')).toBeNull()
  })

  it('3. a barter-linked escrow requires both parties real', async () => {
    const admin = fakeTableData({
      escrow_transactions: [{ id: 'e3', order_id: null, booking_id: null, barter_agreement_id: 'ba1' }],
      barter_agreements: [{ id: 'ba1', party_a_id: 'pa1', party_b_id: 'pb1' }],
      profiles: [{ id: 'pa1', data_classification: 'real' }, { id: 'pb1', data_classification: 'test' }],
      disputes: [],
    })
    expect(await getAdminEscrowDetail(admin, 'e3')).toBeNull()
  })

  it('4. a missing escrow row returns null', async () => {
    const admin = fakeTableData({ escrow_transactions: [] })
    expect(await getAdminEscrowDetail(admin, 'missing')).toBeNull()
  })
})

describe('escrow-service: getAdminEscrowDetail RTB real-data scope (category: ADMIN-CONTROL-CENTRE-BATCH-D3-E-F1)', () => {
  it('8. RTB escrow + non-test agreement + real merchant + real customer => real', async () => {
    const admin = fakeTableData({
      escrow_transactions: [{ id: 'e-rtb-1', order_id: null, booking_id: null, barter_agreement_id: null, rent_to_buy_agreement_id: 'rtb1' }],
      rent_to_buy_agreements: [{ id: 'rtb1', is_test: false, merchant_id: 'm1', customer_id: 'c1' }],
      profiles: [{ id: 'm1', data_classification: 'real' }, { id: 'c1', data_classification: 'real' }],
      disputes: [],
    })
    expect(await getAdminEscrowDetail(admin, 'e-rtb-1')).not.toBeNull()
  })

  it('9. RTB escrow + is_test=true agreement => excluded even though both parties are real', async () => {
    const admin = fakeTableData({
      escrow_transactions: [{ id: 'e-rtb-2', order_id: null, booking_id: null, barter_agreement_id: null, rent_to_buy_agreement_id: 'rtb2' }],
      rent_to_buy_agreements: [{ id: 'rtb2', is_test: true, merchant_id: 'm2', customer_id: 'c2' }],
      profiles: [{ id: 'm2', data_classification: 'real' }, { id: 'c2', data_classification: 'real' }],
      disputes: [],
    })
    expect(await getAdminEscrowDetail(admin, 'e-rtb-2')).toBeNull()
  })

  it('10. RTB escrow + test merchant => excluded', async () => {
    const admin = fakeTableData({
      escrow_transactions: [{ id: 'e-rtb-3', order_id: null, booking_id: null, barter_agreement_id: null, rent_to_buy_agreement_id: 'rtb3' }],
      rent_to_buy_agreements: [{ id: 'rtb3', is_test: false, merchant_id: 'm3', customer_id: 'c3' }],
      profiles: [{ id: 'm3', data_classification: 'test' }, { id: 'c3', data_classification: 'real' }],
      disputes: [],
    })
    expect(await getAdminEscrowDetail(admin, 'e-rtb-3')).toBeNull()
  })

  it('11. RTB escrow + unknown merchant => excluded', async () => {
    const admin = fakeTableData({
      escrow_transactions: [{ id: 'e-rtb-4', order_id: null, booking_id: null, barter_agreement_id: null, rent_to_buy_agreement_id: 'rtb4' }],
      rent_to_buy_agreements: [{ id: 'rtb4', is_test: false, merchant_id: 'm4', customer_id: 'c4' }],
      profiles: [{ id: 'm4', data_classification: 'unknown' }, { id: 'c4', data_classification: 'real' }],
      disputes: [],
    })
    expect(await getAdminEscrowDetail(admin, 'e-rtb-4')).toBeNull()
  })

  it('12. RTB escrow + test customer => excluded', async () => {
    const admin = fakeTableData({
      escrow_transactions: [{ id: 'e-rtb-5', order_id: null, booking_id: null, barter_agreement_id: null, rent_to_buy_agreement_id: 'rtb5' }],
      rent_to_buy_agreements: [{ id: 'rtb5', is_test: false, merchant_id: 'm5', customer_id: 'c5' }],
      profiles: [{ id: 'm5', data_classification: 'real' }, { id: 'c5', data_classification: 'test' }],
      disputes: [],
    })
    expect(await getAdminEscrowDetail(admin, 'e-rtb-5')).toBeNull()
  })

  it('13. RTB escrow + unknown customer => excluded', async () => {
    const admin = fakeTableData({
      escrow_transactions: [{ id: 'e-rtb-6', order_id: null, booking_id: null, barter_agreement_id: null, rent_to_buy_agreement_id: 'rtb6' }],
      rent_to_buy_agreements: [{ id: 'rtb6', is_test: false, merchant_id: 'm6', customer_id: 'c6' }],
      profiles: [{ id: 'm6', data_classification: 'real' }, { id: 'c6', data_classification: 'unknown' }],
      disputes: [],
    })
    expect(await getAdminEscrowDetail(admin, 'e-rtb-6')).toBeNull()
  })

  it('14. RTB escrow whose rent_to_buy_agreements row is missing fails closed', async () => {
    const admin = fakeTableData({
      escrow_transactions: [{ id: 'e-rtb-7', order_id: null, booking_id: null, barter_agreement_id: null, rent_to_buy_agreement_id: 'rtb-missing' }],
      rent_to_buy_agreements: [],
      disputes: [],
    })
    expect(await getAdminEscrowDetail(admin, 'e-rtb-7')).toBeNull()
  })

  it('15. a real RTB escrow detail direct lookup resolves with a synthetic RTB transaction reference', async () => {
    const admin = fakeTableData({
      escrow_transactions: [{ id: 'e-rtb-8', order_id: null, booking_id: null, barter_agreement_id: null, rent_to_buy_agreement_id: 'rtb-12345678' }],
      rent_to_buy_agreements: [{ id: 'rtb-12345678', is_test: false, merchant_id: 'm8', customer_id: 'c8' }],
      profiles: [{ id: 'm8', data_classification: 'real' }, { id: 'c8', data_classification: 'real' }],
      disputes: [],
    })
    const detail = await getAdminEscrowDetail(admin, 'e-rtb-8')
    expect(detail?.transactionReference).toBe('RTB-RTB-1234')
  })
})

describe('escrow-service: listAdminEscrowTransactions real-data scope (category: ADMIN-CONTROL-CENTRE-BATCH-D3-E)', () => {
  it('5. excludes a test-linked escrow transaction from the returned list, including a real one alongside it', async () => {
    const admin = fakeTableData({
      escrow_transactions: [
        { id: 'e-real', transaction_type: 'rental', status: 'funded', provider: 'mock', principal_amount: 100, secure_transaction_fee_amount: 5, currency: 'ZAR', order_id: null, booking_id: 'bk-real', barter_agreement_id: null, created_at: '2026-01-02', funded_at: '2026-01-02', released_at: null, refunded_at: null },
        { id: 'e-test', transaction_type: 'rental', status: 'funded', provider: 'mock', principal_amount: 100, secure_transaction_fee_amount: 5, currency: 'ZAR', order_id: null, booking_id: 'bk-test', barter_agreement_id: null, created_at: '2026-01-01', funded_at: '2026-01-01', released_at: null, refunded_at: null },
      ],
      bookings: [
        { id: 'bk-real', booking_reference: 'BK-REAL', renter_id: 'r1', merchant_id: 'm1', listing_id: 'l1' },
        { id: 'bk-test', booking_reference: 'BK-TEST', renter_id: 'r2', merchant_id: 'm2', listing_id: 'l2' },
      ],
      profiles: [
        { id: 'r1', data_classification: 'real' }, { id: 'm1', data_classification: 'real' },
        { id: 'r2', data_classification: 'test' }, { id: 'm2', data_classification: 'real' },
      ],
      listings: [{ id: 'l1', is_test: false }, { id: 'l2', is_test: false }],
      disputes: [],
    })
    const results = await listAdminEscrowTransactions(admin, {})
    expect(results.map((r) => r.id)).toEqual(['e-real'])
  })

  it('16. [D3-E-F1] includes a real RTB-linked escrow and excludes a test-merchant RTB-linked escrow in the same list', async () => {
    const admin = fakeTableData({
      escrow_transactions: [
        { id: 'e-rtb-real', transaction_type: 'rent_to_buy', status: 'funded', provider: 'mock', principal_amount: 500, secure_transaction_fee_amount: 0, currency: 'ZAR', order_id: null, booking_id: null, barter_agreement_id: null, rent_to_buy_agreement_id: 'rtb-real', created_at: '2026-01-02', funded_at: '2026-01-02', released_at: null, refunded_at: null },
        { id: 'e-rtb-test', transaction_type: 'rent_to_buy', status: 'funded', provider: 'mock', principal_amount: 500, secure_transaction_fee_amount: 0, currency: 'ZAR', order_id: null, booking_id: null, barter_agreement_id: null, rent_to_buy_agreement_id: 'rtb-test', created_at: '2026-01-01', funded_at: '2026-01-01', released_at: null, refunded_at: null },
      ],
      rent_to_buy_agreements: [
        { id: 'rtb-real', is_test: false, merchant_id: 'm1', customer_id: 'c1' },
        { id: 'rtb-test', is_test: false, merchant_id: 'm2', customer_id: 'c2' },
      ],
      profiles: [
        { id: 'm1', data_classification: 'real' }, { id: 'c1', data_classification: 'real' },
        { id: 'm2', data_classification: 'test' }, { id: 'c2', data_classification: 'real' },
      ],
      disputes: [],
    })
    const results = await listAdminEscrowTransactions(admin, {})
    expect(results.map((r) => r.id)).toEqual(['e-rtb-real'])
  })
})

describe('escrow-service: getRealEscrowOverviewCounts (category: ADMIN-CONTROL-CENTRE-BATCH-D3-E)', () => {
  it('6. counts only real-linked escrow transactions per status', async () => {
    const admin = fakeTableData({
      escrow_transactions: [
        { order_id: 'o1', booking_id: null, barter_agreement_id: null, status: 'pending' },
        { order_id: 'o2', booking_id: null, barter_agreement_id: null, status: 'pending' },
      ],
      orders: [
        { id: 'o1', buyer_id: 'b1', seller_id: 's1', listing_id: 'l1' },
        { id: 'o2', buyer_id: 'b2', seller_id: 's2', listing_id: 'l2' },
      ],
      listings: [{ id: 'l1', is_test: false }, { id: 'l2', is_test: true }],
      profiles: [
        { id: 'b1', data_classification: 'real' }, { id: 's1', data_classification: 'real' },
        { id: 'b2', data_classification: 'real' }, { id: 's2', data_classification: 'real' },
      ],
    })
    const counts = await getRealEscrowOverviewCounts(admin)
    expect(counts.escrowTransactionsPending).toBe(1)
  })

  it('7. zero matching rows resolves to 0 for every field', async () => {
    const admin = fakeTableData({ escrow_transactions: [] })
    const counts = await getRealEscrowOverviewCounts(admin)
    expect(Object.values(counts)).toEqual([0, 0, 0, 0, 0])
  })

  it('17. [D3-E-F1] a real RTB-linked escrow transaction is now counted correctly', async () => {
    const admin = fakeTableData({
      escrow_transactions: [
        { order_id: null, booking_id: null, barter_agreement_id: null, rent_to_buy_agreement_id: 'rtb1', status: 'funded' },
      ],
      rent_to_buy_agreements: [{ id: 'rtb1', is_test: false, merchant_id: 'm1', customer_id: 'c1' }],
      profiles: [{ id: 'm1', data_classification: 'real' }, { id: 'c1', data_classification: 'real' }],
    })
    const counts = await getRealEscrowOverviewCounts(admin)
    expect(counts.escrowTransactionsFunded).toBe(1)
  })
})
