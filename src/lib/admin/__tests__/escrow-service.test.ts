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
})
