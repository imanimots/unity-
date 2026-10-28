import { describe, it, expect } from 'vitest'
import { ADMIN_PAYOUT_CSV_COLUMNS, getAdminPayoutDetail, getRealPayoutOverviewCounts } from '../payouts-service'

describe('payouts-service: CSV export column list (category: CSV Exports, Security)', () => {
  it('1. excludes personal identity numbers, addresses, banking details, payment credentials, raw failure text', () => {
    const forbidden = ['idnumber', 'passport', 'address', 'bank', 'card', 'kyc', 'secret', 'token', 'email', 'phone', 'rawfailure', 'failuremessage']
    for (const col of ADMIN_PAYOUT_CSV_COLUMNS) {
      const lower = col.toLowerCase()
      for (const f of forbidden) {
        expect(lower.includes(f), `column "${col}" should not include "${f}"`).toBe(false)
      }
    }
  })
  it('2. includes merchant display name, not a raw merchant id', () => {
    expect(ADMIN_PAYOUT_CSV_COLUMNS).toContain('merchantName')
    expect(ADMIN_PAYOUT_CSV_COLUMNS).not.toContain('merchantId')
  })
  it('3. includes amount, currency, status, and payout lifecycle timestamps', () => {
    expect(ADMIN_PAYOUT_CSV_COLUMNS).toContain('amount')
    expect(ADMIN_PAYOUT_CSV_COLUMNS).toContain('currency')
    expect(ADMIN_PAYOUT_CSV_COLUMNS).toContain('status')
    expect(ADMIN_PAYOUT_CSV_COLUMNS).toContain('paidAt')
  })
})

function matchesFilters(r: Record<string, unknown>, filters: Record<string, unknown>): boolean {
  return Object.entries(filters).every(([k, v]) => {
    if (k.startsWith('__in_')) return (v as unknown[]).includes(r[k.replace('__in_', '')])
    if (k.startsWith('__lt_')) return (r[k.replace('__lt_', '')] as string) < (v as string)
    return r[k] === v
  })
}

/** Generic per-table fixture mock: a row is matched if every applied `.eq()`/`.in()`/`.lt()` filter matches; the same fixture serves both scope checks and display lookups regardless of which columns were selected. */
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
        lt: (col: string, val: unknown) => {
          filters = { ...filters, [`__lt_${col}`]: val }
          return obj
        },
        order: () => obj,
        maybeSingle: () => {
          const match = rows.find((r) => matchesFilters(r, filters))
          return Promise.resolve({ data: match ?? null, error: null })
        },
        then: (resolve: (v: { data: Record<string, unknown>[]; error: null }) => void) => {
          const matched = rows.filter((r) => matchesFilters(r, filters))
          resolve({ data: matched, error: null })
        },
      }
      return obj
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

describe('payouts-service: getAdminPayoutDetail real-data scope (category: ADMIN-CONTROL-CENTRE-BATCH-D3-E)', () => {
  it('1. a payout with no booking_id requires only the merchant real', async () => {
    const admin = fakeTableData({
      merchant_payouts: [{ id: 'p1', merchant_id: 'm1', booking_id: null, status: 'paid' }],
      profiles: [{ id: 'm1', full_name: 'Merchant', display_name: null, account_status: 'active', data_classification: 'real' }],
      merchant_payout_history: [],
      email_deliveries: [],
      payments: [],
    })
    expect(await getAdminPayoutDetail(admin, 'p1')).not.toBeNull()
  })

  it('2. a payout with no booking_id is excluded when the merchant is test', async () => {
    const admin = fakeTableData({
      merchant_payouts: [{ id: 'p2', merchant_id: 'm2', booking_id: null, status: 'paid' }],
      profiles: [{ id: 'm2', full_name: 'Merchant', display_name: null, account_status: 'active', data_classification: 'test' }],
      merchant_payout_history: [],
      email_deliveries: [],
      payments: [],
    })
    expect(await getAdminPayoutDetail(admin, 'p2')).toBeNull()
  })

  it('3. [D3-E] a payout WITH a booking_id inherits the COMPLETE booking rule -- merchant real alone is not sufficient when a test-linked renter is on the same booking', async () => {
    const admin = fakeTableData({
      merchant_payouts: [{ id: 'p3', merchant_id: 'm3', booking_id: 'bk1', status: 'paid' }],
      profiles: [
        { id: 'm3', full_name: 'Merchant', display_name: null, account_status: 'active', data_classification: 'real' },
        { id: 'r1', data_classification: 'test' },
      ],
      bookings: [{ id: 'bk1', renter_id: 'r1', listing_id: 'l1' }],
      listings: [{ id: 'l1', is_test: false }],
      merchant_payout_history: [],
      email_deliveries: [],
      payments: [],
      disputes: [],
    })
    expect(await getAdminPayoutDetail(admin, 'p3')).toBeNull()
  })

  it('4. [D3-E] a payout WITH a booking_id resolves normally when both merchant and renter are real and the listing is not test', async () => {
    const admin = fakeTableData({
      merchant_payouts: [{ id: 'p4', merchant_id: 'm4', booking_id: 'bk2', status: 'paid' }],
      profiles: [
        { id: 'm4', full_name: 'Merchant', display_name: null, account_status: 'active', data_classification: 'real' },
        { id: 'r2', data_classification: 'real' },
      ],
      bookings: [{ id: 'bk2', renter_id: 'r2', listing_id: 'l2' }],
      listings: [{ id: 'l2', is_test: false }],
      merchant_payout_history: [],
      email_deliveries: [],
      payments: [],
      disputes: [],
    })
    expect(await getAdminPayoutDetail(admin, 'p4')).not.toBeNull()
  })

  it('5. a missing payout row returns null', async () => {
    const admin = fakeTableData({ merchant_payouts: [] })
    expect(await getAdminPayoutDetail(admin, 'missing')).toBeNull()
  })
})

describe('payouts-service: getRealPayoutOverviewCounts (category: ADMIN-CONTROL-CENTRE-BATCH-D3-E)', () => {
  it('6. counts a merchant-only payout (no booking) when the merchant is real', async () => {
    const admin = fakeTableData({
      merchant_payouts: [{ id: 'p1', merchant_id: 'm1', booking_id: null, created_at: '2026-01-01', processing_started_at: null, status: 'pending' }],
      profiles: [{ id: 'm1', data_classification: 'real' }],
    })
    const counts = await getRealPayoutOverviewCounts(admin)
    expect(counts.merchantPayoutsPending).toBe(1)
  })

  it('7. excludes a payout whose booking has a test-linked renter even though the merchant is real', async () => {
    const admin = fakeTableData({
      merchant_payouts: [{ id: 'p2', merchant_id: 'm2', booking_id: 'bk1', created_at: '2026-01-01', processing_started_at: null, status: 'pending' }],
      profiles: [{ id: 'm2', data_classification: 'real' }, { id: 'r1', data_classification: 'test' }],
      bookings: [{ id: 'bk1', renter_id: 'r1', listing_id: 'l1' }],
      listings: [{ id: 'l1', is_test: false }],
    })
    const counts = await getRealPayoutOverviewCounts(admin)
    expect(counts.merchantPayoutsPending).toBe(0)
  })

  it('8. zero matching rows resolves to 0 for every field', async () => {
    const admin = fakeTableData({ merchant_payouts: [] })
    const counts = await getRealPayoutOverviewCounts(admin)
    expect(Object.values(counts)).toEqual([0, 0, 0, 0, 0])
  })
})
