import { describe, it, expect, vi } from 'vitest'
import { countAdminDisputesForUser, listAdminDisputes, getAdminDisputeDetail } from '../disputes-service'

const USER_ID = '11111111-1111-1111-1111-111111111111'

/**
 * A generic chainable mock: every query-builder method (.select/.eq/.or/
 * .order/.limit/.in) returns the same object so any chain length works,
 * and the object is itself awaitable (`.then`) so `await query` resolves
 * to the fixed result passed in -- mirrors real supabase-js query
 * builders being PromiseLike.
 */
function chainable(result: { data?: unknown; error?: unknown; count?: number | null }) {
  const obj: Record<string, unknown> = {
    select: () => obj,
    eq: () => obj,
    or: () => obj,
    order: () => obj,
    limit: () => obj,
    in: () => obj,
    then: (resolve: (v: typeof result) => void) => resolve(result),
  }
  return obj
}

function fakeAdminClient(opts: {
  bookingIds?: string[]
  orderIds?: string[]
  barterIds?: string[]
  disputeCount?: number
  disputeRows?: Record<string, unknown>[]
  disputesTableError?: { message: string }
}) {
  const { bookingIds = [], orderIds = [], barterIds = [], disputeCount = 0, disputeRows = [], disputesTableError } = opts

  return {
    from: (table: string) => {
      if (table === 'bookings') return chainable({ data: bookingIds.map((id) => ({ id })), error: null })
      if (table === 'orders') return chainable({ data: orderIds.map((id) => ({ id })), error: null })
      if (table === 'barter_agreements') return chainable({ data: barterIds.map((id) => ({ id })), error: null })
      if (table === 'disputes') {
        return {
          select: (_cols: string, selectOpts?: { count?: string; head?: boolean }) =>
            selectOpts?.head
              ? chainable({ count: disputesTableError ? null : disputeCount, error: disputesTableError ?? null })
              : chainable({ data: disputeRows, error: null }),
        }
      }
      throw new Error(`unexpected table: ${table}`)
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

describe('disputes-service: countAdminDisputesForUser (category: ADMIN-CONTROL-CENTRE-BATCH-A1)', () => {
  it('1. a user with zero raised disputes and zero linked transactions returns 0, not null', async () => {
    const admin = fakeAdminClient({ disputeCount: 0 })
    expect(await countAdminDisputesForUser(admin, USER_ID)).toBe(0)
  })

  it('2. returns whatever the disputes count query reports -- never hardcoded', async () => {
    const admin = fakeAdminClient({ disputeCount: 3, bookingIds: ['b1', 'b2'] })
    expect(await countAdminDisputesForUser(admin, USER_ID)).toBe(3)
  })

  it('3. propagates a real query error rather than silently returning 0', async () => {
    const admin = fakeAdminClient({ disputesTableError: { message: 'boom' } })
    await expect(countAdminDisputesForUser(admin, USER_ID)).rejects.toBeTruthy()
  })
})

describe('disputes-service: listAdminDisputes participantUserId filter (category: ADMIN-CONTROL-CENTRE-BATCH-A1)', () => {
  it('4. omitting participantUserId never touches bookings/orders/barter_agreements', async () => {
    const bookingsSpy = vi.fn()
    const admin = {
      from: (table: string) => {
        if (table === 'bookings') {
          bookingsSpy()
          return chainable({ data: [], error: null })
        }
        if (table === 'disputes') return chainable({ data: [], error: null })
        return chainable({ data: [], error: null })
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    await listAdminDisputes(admin, {})
    expect(bookingsSpy).not.toHaveBeenCalled()
  })

  it('5. a participantUserId filter does look up bookings/orders/barter_agreements before querying disputes', async () => {
    const bookingsSpy = vi.fn()
    const admin = {
      from: (table: string) => {
        if (table === 'bookings') {
          bookingsSpy()
          return chainable({ data: [{ id: 'b1' }], error: null })
        }
        if (table === 'disputes') return chainable({ data: [], error: null })
        return chainable({ data: [], error: null })
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    await listAdminDisputes(admin, { participantUserId: USER_ID })
    expect(bookingsSpy).toHaveBeenCalled()
  })
})

/**
 * D3-D: a flexible per-table mock that supports both a `.in()`-filtered
 * list result and a `.eq('id', x).maybeSingle()` single-row lookup from
 * the SAME fixed table data, used to test resolveDisputeRealClassification's
 * parent-resolution fan-out (bookings/orders/barter_agreements/
 * rent_to_buy_agreements/profiles) without hand-building a bespoke mock
 * per test.
 */
function fakeTableData(tables: Record<string, Record<string, unknown>[]>) {
  return {
    from: (table: string) => {
      const rows = tables[table] ?? []
      let eqFilters: Record<string, unknown> = {}
      const obj: Record<string, unknown> = {
        select: () => obj,
        eq: (col: string, val: unknown) => {
          eqFilters = { ...eqFilters, [col]: val }
          return obj
        },
        in: (col: string, vals: unknown[]) => {
          eqFilters = { ...eqFilters, [`__in_${col}`]: vals }
          return obj
        },
        order: () => obj,
        maybeSingle: () => {
          const match = rows.find((r) => Object.entries(eqFilters).every(([k, v]) => (k.startsWith('__in_') ? (v as unknown[]).includes(r[k.replace('__in_', '')]) : r[k] === v)))
          return Promise.resolve({ data: match ?? null, error: null })
        },
        then: (resolve: (v: { data: Record<string, unknown>[]; error: null }) => void) => {
          const matched = rows.filter((r) => Object.entries(eqFilters).every(([k, v]) => (k.startsWith('__in_') ? (v as unknown[]).includes(r[k.replace('__in_', '')]) : r[k] === v)))
          resolve({ data: matched, error: null })
        },
      }
      return obj
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

describe('disputes-service: real-data provenance inherited from the linked parent transaction (category: ADMIN-CONTROL-CENTRE-BATCH-D3-D)', () => {
  it('6. getAdminDisputeDetail: a booking-linked dispute resolves real only when renter+merchant+listing are all real/non-test', async () => {
    const real = fakeTableData({
      disputes: [{ id: 'd1', booking_id: 'bk1', order_id: null, barter_agreement_id: null, rent_to_buy_agreement_id: null }],
      bookings: [{ id: 'bk1', renter_id: 'r1', merchant_id: 'm1', listings: { is_test: false } }],
      profiles: [{ id: 'r1', data_classification: 'real' }, { id: 'm1', data_classification: 'real' }],
      dispute_history: [],
      dispute_evidence: [],
    })
    expect(await getAdminDisputeDetail(real, 'd1')).not.toBeNull()

    const testLinked = fakeTableData({
      disputes: [{ id: 'd1', booking_id: 'bk1', order_id: null, barter_agreement_id: null, rent_to_buy_agreement_id: null }],
      bookings: [{ id: 'bk1', renter_id: 'r1', merchant_id: 'm1', listings: { is_test: false } }],
      profiles: [{ id: 'r1', data_classification: 'test' }, { id: 'm1', data_classification: 'real' }],
      dispute_history: [],
      dispute_evidence: [],
    })
    expect(await getAdminDisputeDetail(testLinked, 'd1')).toBeNull()
  })

  it('7. getAdminDisputeDetail: an order-linked dispute resolves real only when buyer+seller are both real', async () => {
    const admin = fakeTableData({
      disputes: [{ id: 'd2', booking_id: null, order_id: 'o1', barter_agreement_id: null, rent_to_buy_agreement_id: null }],
      orders: [{ id: 'o1', buyer_id: 'b1', seller_id: 's1' }],
      profiles: [{ id: 'b1', data_classification: 'real' }, { id: 's1', data_classification: 'unknown' }],
      dispute_history: [],
      dispute_evidence: [],
    })
    expect(await getAdminDisputeDetail(admin, 'd2')).toBeNull()
  })

  it('8. getAdminDisputeDetail: a barter-linked dispute resolves real only when both parties are real', async () => {
    const admin = fakeTableData({
      disputes: [{ id: 'd3', booking_id: null, order_id: null, barter_agreement_id: 'ba1', rent_to_buy_agreement_id: null }],
      barter_agreements: [{ id: 'ba1', party_a_id: 'pa1', party_b_id: 'pb1' }],
      profiles: [{ id: 'pa1', data_classification: 'real' }, { id: 'pb1', data_classification: 'real' }],
      dispute_history: [],
      dispute_evidence: [],
    })
    expect(await getAdminDisputeDetail(admin, 'd3')).not.toBeNull()
  })

  it('9. getAdminDisputeDetail: a rent-to-buy-linked dispute requires the agreement is_test=false plus both merchant/customer real', async () => {
    const admin = fakeTableData({
      disputes: [{ id: 'd4', booking_id: null, order_id: null, barter_agreement_id: null, rent_to_buy_agreement_id: 'rtb1' }],
      rent_to_buy_agreements: [{ id: 'rtb1', merchant_id: 'm1', customer_id: 'c1', is_test: true }],
      profiles: [{ id: 'm1', data_classification: 'real' }, { id: 'c1', data_classification: 'real' }],
      dispute_history: [],
      dispute_evidence: [],
    })
    expect(await getAdminDisputeDetail(admin, 'd4')).toBeNull()
  })

  it('10. getAdminDisputeDetail: a missing dispute row returns null', async () => {
    const admin = fakeTableData({ disputes: [] })
    expect(await getAdminDisputeDetail(admin, 'missing')).toBeNull()
  })

  it('11. listAdminDisputes: excludes a test-linked dispute from the returned list, including a real one alongside it', async () => {
    const admin = fakeTableData({
      disputes: [
        { id: 'd-real', booking_id: 'bk-real', order_id: null, barter_agreement_id: null, rent_to_buy_agreement_id: null, title: 'Real', status: 'open', raised_by: 'r1', assigned_admin_id: null, created_at: '2026-01-02', updated_at: '2026-01-02', outcome: null },
        { id: 'd-test', booking_id: 'bk-test', order_id: null, barter_agreement_id: null, rent_to_buy_agreement_id: null, title: 'Test', status: 'open', raised_by: 'r2', assigned_admin_id: null, created_at: '2026-01-01', updated_at: '2026-01-01', outcome: null },
      ],
      bookings: [
        { id: 'bk-real', booking_reference: 'BK-REAL', renter_id: 'r1', merchant_id: 'm1', listings: { is_test: false } },
        { id: 'bk-test', booking_reference: 'BK-TEST', renter_id: 'r2', merchant_id: 'm2', listings: { is_test: false } },
      ],
      profiles: [
        { id: 'r1', full_name: 'Renter Real', display_name: null, data_classification: 'real' },
        { id: 'm1', full_name: 'Merchant Real', display_name: null, data_classification: 'real' },
        { id: 'r2', full_name: 'Renter Test', display_name: null, data_classification: 'test' },
        { id: 'm2', full_name: 'Merchant Test', display_name: null, data_classification: 'real' },
      ],
    })
    const results = await listAdminDisputes(admin, {})
    expect(results.map((r) => r.id)).toEqual(['d-real'])
  })

  it('12. [D3-D-F1] getAdminDisputeDetail: an order-linked dispute requires the SAME complete order rule as orders-service -- a test-flagged listing blocks it even though both buyer and seller are real', async () => {
    const admin = fakeTableData({
      disputes: [{ id: 'd5', booking_id: null, order_id: 'o1', barter_agreement_id: null, rent_to_buy_agreement_id: null }],
      orders: [{ id: 'o1', buyer_id: 'b1', seller_id: 's1', listing_id: 'l1' }],
      listings: [{ id: 'l1', is_test: true }],
      profiles: [{ id: 'b1', data_classification: 'real' }, { id: 's1', data_classification: 'real' }],
      dispute_history: [],
      dispute_evidence: [],
    })
    expect(await getAdminDisputeDetail(admin, 'd5')).toBeNull()
  })

  it('13. [D3-D-F1] getAdminDisputeDetail: an order-linked dispute resolves real when buyer+seller are real AND the listing is not test', async () => {
    const admin = fakeTableData({
      disputes: [{ id: 'd6', booking_id: null, order_id: 'o2', barter_agreement_id: null, rent_to_buy_agreement_id: null }],
      orders: [{ id: 'o2', buyer_id: 'b2', seller_id: 's2', listing_id: 'l2' }],
      listings: [{ id: 'l2', is_test: false }],
      profiles: [{ id: 'b2', data_classification: 'real' }, { id: 's2', data_classification: 'real' }],
      dispute_history: [],
      dispute_evidence: [],
    })
    expect(await getAdminDisputeDetail(admin, 'd6')).not.toBeNull()
  })
})
