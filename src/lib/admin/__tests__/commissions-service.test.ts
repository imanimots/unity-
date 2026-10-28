import { describe, it, expect } from 'vitest'
import { listAdminUnityCommissions, getAdminUnityCommissionDetail, getRealUnityCommissionOverviewCounts } from '../commissions-service'

/** Mirrors disputes-service.test.ts's fakeTableData -- a flexible per-table mock supporting both `.in()`-filtered list results and `.eq('id', x).maybeSingle()` single-row lookups from the same fixed table data. */
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
        gt: (col: string, val: unknown) => {
          filters = { ...filters, [`__gt_${col}`]: val }
          return obj
        },
        order: () => obj,
        maybeSingle: () => {
          const match = rows.find((r) =>
            Object.entries(filters).every(([k, v]) => {
              if (k.startsWith('__in_')) return (v as unknown[]).includes(r[k.replace('__in_', '')])
              if (k.startsWith('__gt_')) return (r[k.replace('__gt_', '')] as number) > (v as number)
              return r[k] === v
            })
          )
          return Promise.resolve({ data: match ?? null, error: null })
        },
        then: (resolve: (v: { data: Record<string, unknown>[]; error: null }) => void) => {
          const matched = rows.filter((r) =>
            Object.entries(filters).every(([k, v]) => {
              if (k.startsWith('__in_')) return (v as unknown[]).includes(r[k.replace('__in_', '')])
              if (k.startsWith('__gt_')) return (r[k.replace('__gt_', '')] as number) > (v as number)
              return r[k] === v
            })
          )
          resolve({ data: matched, error: null })
        },
      }
      return obj
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

describe('commissions-service: getAdminUnityCommissionDetail real-data scope (category: ADMIN-CONTROL-CENTRE-BATCH-D3-E)', () => {
  it('1. an order-linked commission requires buyer+seller real and the listing non-test', async () => {
    const real = fakeTableData({
      unity_commissions: [{ id: 'c1', order_id: 'o1', booking_id: null }],
      orders: [{ id: 'o1', buyer_id: 'b1', seller_id: 's1', listing_id: 'l1' }],
      listings: [{ id: 'l1', is_test: false }],
      profiles: [{ id: 'b1', data_classification: 'real' }, { id: 's1', data_classification: 'real' }],
      unity_commission_history: [],
      unity_commission_adjustments: [],
      payments: [],
    })
    expect(await getAdminUnityCommissionDetail(real, 'c1')).not.toBeNull()
  })

  it('2. an order-linked commission is excluded when the listing is test, even though buyer+seller are real', async () => {
    const admin = fakeTableData({
      unity_commissions: [{ id: 'c2', order_id: 'o2', booking_id: null }],
      orders: [{ id: 'o2', buyer_id: 'b2', seller_id: 's2', listing_id: 'l2' }],
      listings: [{ id: 'l2', is_test: true }],
      profiles: [{ id: 'b2', data_classification: 'real' }, { id: 's2', data_classification: 'real' }],
      unity_commission_history: [],
      unity_commission_adjustments: [],
      payments: [],
    })
    expect(await getAdminUnityCommissionDetail(admin, 'c2')).toBeNull()
  })

  it('3. a booking-linked commission requires renter+merchant real and the listing non-test', async () => {
    const admin = fakeTableData({
      unity_commissions: [{ id: 'c3', order_id: null, booking_id: 'bk1' }],
      bookings: [{ id: 'bk1', renter_id: 'r1', merchant_id: 'm1', listing_id: 'l3' }],
      listings: [{ id: 'l3', is_test: false }],
      profiles: [{ id: 'r1', data_classification: 'test' }, { id: 'm1', data_classification: 'real' }],
      unity_commission_history: [],
      unity_commission_adjustments: [],
      payments: [],
    })
    expect(await getAdminUnityCommissionDetail(admin, 'c3')).toBeNull()
  })

  it('4. a missing commission row returns null', async () => {
    const admin = fakeTableData({ unity_commissions: [] })
    expect(await getAdminUnityCommissionDetail(admin, 'missing')).toBeNull()
  })
})

describe('commissions-service: listAdminUnityCommissions real-data scope (category: ADMIN-CONTROL-CENTRE-BATCH-D3-E)', () => {
  it('5. excludes a booking-linked commission whose renter is test from the returned list, including a real one alongside it', async () => {
    const admin = fakeTableData({
      unity_commissions: [
        { id: 'c-real', transaction_type: 'rental', status: 'earned', merchant_id: 'm1', listing_id: 'l-real', order_id: null, booking_id: 'bk-real', payment_id: 'pay1', merchant_plan_id: 'pro', eligible_base: 100, standard_rate_bps: 500, excess_rate_bps: 0, excess_base: 0, commission_amount: 5, currency: 'ZAR', created_at: '2026-01-02', earned_at: '2026-01-02', listings: { title: 'Real' } },
        { id: 'c-test', transaction_type: 'rental', status: 'earned', merchant_id: 'm2', listing_id: 'l-test', order_id: null, booking_id: 'bk-test', payment_id: 'pay2', merchant_plan_id: 'pro', eligible_base: 100, standard_rate_bps: 500, excess_rate_bps: 0, excess_base: 0, commission_amount: 5, currency: 'ZAR', created_at: '2026-01-01', earned_at: '2026-01-01', listings: { title: 'Test' } },
      ],
      bookings: [
        { id: 'bk-real', renter_id: 'r1', merchant_id: 'm1', listing_id: 'l-real' },
        { id: 'bk-test', renter_id: 'r2', merchant_id: 'm2', listing_id: 'l-test' },
      ],
      listings: [{ id: 'l-real', is_test: false }, { id: 'l-test', is_test: false }],
      profiles: [
        { id: 'r1', full_name: 'Renter Real', display_name: null, data_classification: 'real' },
        { id: 'm1', full_name: 'Merchant Real', display_name: null, data_classification: 'real' },
        { id: 'r2', full_name: 'Renter Test', display_name: null, data_classification: 'test' },
        { id: 'm2', full_name: 'Merchant Test', display_name: null, data_classification: 'real' },
      ],
      payments: [],
    })
    const results = await listAdminUnityCommissions(admin, {})
    expect(results.map((r) => r.id)).toEqual(['c-real'])
  })
})

describe('commissions-service: getRealUnityCommissionOverviewCounts (category: ADMIN-CONTROL-CENTRE-BATCH-D3-E)', () => {
  it('6. counts only real-linked commissions per status', async () => {
    const admin = fakeTableData({
      unity_commissions: [
        { order_id: 'o1', booking_id: null, transaction_type: 'sale', excess_base: 0, status: 'pending' },
        { order_id: 'o2', booking_id: null, transaction_type: 'sale', excess_base: 0, status: 'pending' },
      ],
      orders: [
        { id: 'o1', buyer_id: 'b1', seller_id: 's1', listing_id: 'l1' },
        { id: 'o2', buyer_id: 'b2', seller_id: 's2', listing_id: 'l2' },
      ],
      listings: [{ id: 'l1', is_test: false }, { id: 'l2', is_test: false }],
      profiles: [
        { id: 'b1', data_classification: 'real' }, { id: 's1', data_classification: 'real' },
        { id: 'b2', data_classification: 'unknown' }, { id: 's2', data_classification: 'real' },
      ],
    })
    const counts = await getRealUnityCommissionOverviewCounts(admin)
    expect(counts.unityCommissionsPending).toBe(1)
  })

  it('7. zero matching rows resolves to 0 for every field, never undefined/NaN', async () => {
    const admin = fakeTableData({ unity_commissions: [] })
    const counts = await getRealUnityCommissionOverviewCounts(admin)
    expect(Object.values(counts)).toEqual([0, 0, 0, 0, 0])
  })
})
