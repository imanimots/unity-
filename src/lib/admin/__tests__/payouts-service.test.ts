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

describe('payouts-service: getAdminPayoutDetail RTB real-data scope (category: ADMIN-CONTROL-CENTRE-BATCH-D3-E-F2)', () => {
  it('9. a payout with no booking_id is RTB-linked, not unparented -- a non-test agreement with real merchant and real customer resolves normally', async () => {
    const admin = fakeTableData({
      merchant_payouts: [{ id: 'p9', merchant_id: 'm9', booking_id: null, rent_to_buy_agreement_id: 'rtb1', status: 'paid' }],
      rent_to_buy_agreements: [{ id: 'rtb1', is_test: false, merchant_id: 'm9', customer_id: 'c9' }],
      profiles: [
        { id: 'm9', full_name: 'Merchant', display_name: null, account_status: 'active', data_classification: 'real' },
        { id: 'c9', data_classification: 'real' },
      ],
      merchant_payout_history: [],
      email_deliveries: [],
      payments: [],
    })
    expect(await getAdminPayoutDetail(admin, 'p9')).not.toBeNull()
  })

  it('10. an RTB-linked payout is excluded when the agreement itself is is_test=true, even though the payout\'s own merchant is real', async () => {
    const admin = fakeTableData({
      merchant_payouts: [{ id: 'p10', merchant_id: 'm10', booking_id: null, rent_to_buy_agreement_id: 'rtb2', status: 'paid' }],
      rent_to_buy_agreements: [{ id: 'rtb2', is_test: true, merchant_id: 'm10', customer_id: 'c10' }],
      profiles: [
        { id: 'm10', full_name: 'Merchant', display_name: null, account_status: 'active', data_classification: 'real' },
        { id: 'c10', data_classification: 'real' },
      ],
      merchant_payout_history: [],
      email_deliveries: [],
      payments: [],
    })
    expect(await getAdminPayoutDetail(admin, 'p10')).toBeNull()
  })

  it('11. an RTB-linked payout is excluded when the RTB agreement\'s own merchant is test, even though the payout\'s own merchant_id profile is real -- the RTB merchant check is resolved from the agreement, not reused from the payout', async () => {
    const admin = fakeTableData({
      merchant_payouts: [{ id: 'p11', merchant_id: 'm11', booking_id: null, rent_to_buy_agreement_id: 'rtb3', status: 'paid' }],
      rent_to_buy_agreements: [{ id: 'rtb3', is_test: false, merchant_id: 'm11-agreement', customer_id: 'c11' }],
      profiles: [
        { id: 'm11', full_name: 'Merchant', display_name: null, account_status: 'active', data_classification: 'real' },
        { id: 'm11-agreement', data_classification: 'test' },
        { id: 'c11', data_classification: 'real' },
      ],
      merchant_payout_history: [],
      email_deliveries: [],
      payments: [],
    })
    expect(await getAdminPayoutDetail(admin, 'p11')).toBeNull()
  })

  it('12. an RTB-linked payout is excluded when the RTB merchant is unknown', async () => {
    const admin = fakeTableData({
      merchant_payouts: [{ id: 'p12', merchant_id: 'm12', booking_id: null, rent_to_buy_agreement_id: 'rtb4', status: 'paid' }],
      rent_to_buy_agreements: [{ id: 'rtb4', is_test: false, merchant_id: 'm12', customer_id: 'c12' }],
      profiles: [
        { id: 'm12', full_name: 'Merchant', display_name: null, account_status: 'active', data_classification: 'unknown' },
        { id: 'c12', data_classification: 'real' },
      ],
      merchant_payout_history: [],
      email_deliveries: [],
      payments: [],
    })
    expect(await getAdminPayoutDetail(admin, 'p12')).toBeNull()
  })

  it('13. an RTB-linked payout is excluded when the RTB customer is test', async () => {
    const admin = fakeTableData({
      merchant_payouts: [{ id: 'p13', merchant_id: 'm13', booking_id: null, rent_to_buy_agreement_id: 'rtb5', status: 'paid' }],
      rent_to_buy_agreements: [{ id: 'rtb5', is_test: false, merchant_id: 'm13', customer_id: 'c13' }],
      profiles: [
        { id: 'm13', full_name: 'Merchant', display_name: null, account_status: 'active', data_classification: 'real' },
        { id: 'c13', data_classification: 'test' },
      ],
      merchant_payout_history: [],
      email_deliveries: [],
      payments: [],
    })
    expect(await getAdminPayoutDetail(admin, 'p13')).toBeNull()
  })

  it('14. an RTB-linked payout is excluded when the RTB customer is unknown', async () => {
    const admin = fakeTableData({
      merchant_payouts: [{ id: 'p14', merchant_id: 'm14', booking_id: null, rent_to_buy_agreement_id: 'rtb6', status: 'paid' }],
      rent_to_buy_agreements: [{ id: 'rtb6', is_test: false, merchant_id: 'm14', customer_id: 'c14' }],
      profiles: [
        { id: 'm14', full_name: 'Merchant', display_name: null, account_status: 'active', data_classification: 'real' },
        { id: 'c14', data_classification: 'unknown' },
      ],
      merchant_payout_history: [],
      email_deliveries: [],
      payments: [],
    })
    expect(await getAdminPayoutDetail(admin, 'p14')).toBeNull()
  })

  it('15. an RTB-linked payout whose rent_to_buy_agreements row is missing fails closed', async () => {
    const admin = fakeTableData({
      merchant_payouts: [{ id: 'p15', merchant_id: 'm15', booking_id: null, rent_to_buy_agreement_id: 'rtb-missing', status: 'paid' }],
      rent_to_buy_agreements: [],
      profiles: [{ id: 'm15', full_name: 'Merchant', display_name: null, account_status: 'active', data_classification: 'real' }],
      merchant_payout_history: [],
      email_deliveries: [],
      payments: [],
    })
    expect(await getAdminPayoutDetail(admin, 'p15')).toBeNull()
  })

  it('16. a payout with neither booking_id nor rent_to_buy_agreement_id (an impossible state per merchant_payouts_one_transaction_chk) fails closed rather than falling back to merchant-real-alone', async () => {
    const admin = fakeTableData({
      merchant_payouts: [{ id: 'p16', merchant_id: 'm16', booking_id: null, rent_to_buy_agreement_id: null, status: 'paid' }],
      profiles: [{ id: 'm16', full_name: 'Merchant', display_name: null, account_status: 'active', data_classification: 'real' }],
      merchant_payout_history: [],
      email_deliveries: [],
      payments: [],
    })
    expect(await getAdminPayoutDetail(admin, 'p16')).toBeNull()
  })
})

describe('payouts-service: getRealPayoutOverviewCounts (category: ADMIN-CONTROL-CENTRE-BATCH-D3-E)', () => {
  it('7. excludes a payout whose booking has a test-linked renter even though the merchant is real', async () => {
    const admin = fakeTableData({
      merchant_payouts: [{ id: 'p2', merchant_id: 'm2', booking_id: 'bk1', rent_to_buy_agreement_id: null, created_at: '2026-01-01', processing_started_at: null, status: 'pending' }],
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

describe('payouts-service: getRealPayoutOverviewCounts RTB real-data scope (category: ADMIN-CONTROL-CENTRE-BATCH-D3-E-F2)', () => {
  it('17. counts an RTB-linked payout (no booking_id) when the agreement is non-test and both merchant and customer are real', async () => {
    const admin = fakeTableData({
      merchant_payouts: [{ id: 'p17', merchant_id: 'm17', booking_id: null, rent_to_buy_agreement_id: 'rtb1', created_at: '2026-01-01', processing_started_at: null, status: 'pending' }],
      rent_to_buy_agreements: [{ id: 'rtb1', is_test: false, merchant_id: 'm17', customer_id: 'c17' }],
      profiles: [{ id: 'm17', data_classification: 'real' }, { id: 'c17', data_classification: 'real' }],
    })
    const counts = await getRealPayoutOverviewCounts(admin)
    expect(counts.merchantPayoutsPending).toBe(1)
  })

  it('18. excludes an RTB-linked payout whose agreement is is_test=true even though the merchant is real -- there is no merchant-only RTB shortcut', async () => {
    const admin = fakeTableData({
      merchant_payouts: [{ id: 'p18', merchant_id: 'm18', booking_id: null, rent_to_buy_agreement_id: 'rtb2', created_at: '2026-01-01', processing_started_at: null, status: 'pending' }],
      rent_to_buy_agreements: [{ id: 'rtb2', is_test: true, merchant_id: 'm18', customer_id: 'c18' }],
      profiles: [{ id: 'm18', data_classification: 'real' }, { id: 'c18', data_classification: 'real' }],
    })
    const counts = await getRealPayoutOverviewCounts(admin)
    expect(counts.merchantPayoutsPending).toBe(0)
  })

  it('19. excludes an RTB-linked payout whose agreement customer is test', async () => {
    const admin = fakeTableData({
      merchant_payouts: [{ id: 'p19', merchant_id: 'm19', booking_id: null, rent_to_buy_agreement_id: 'rtb3', created_at: '2026-01-01', processing_started_at: null, status: 'pending' }],
      rent_to_buy_agreements: [{ id: 'rtb3', is_test: false, merchant_id: 'm19', customer_id: 'c19' }],
      profiles: [{ id: 'm19', data_classification: 'real' }, { id: 'c19', data_classification: 'test' }],
    })
    const counts = await getRealPayoutOverviewCounts(admin)
    expect(counts.merchantPayoutsPending).toBe(0)
  })

  it('20. a payout with neither booking_id nor rent_to_buy_agreement_id is never counted', async () => {
    const admin = fakeTableData({
      merchant_payouts: [{ id: 'p20', merchant_id: 'm20', booking_id: null, rent_to_buy_agreement_id: null, created_at: '2026-01-01', processing_started_at: null, status: 'pending' }],
      profiles: [{ id: 'm20', data_classification: 'real' }],
    })
    const counts = await getRealPayoutOverviewCounts(admin)
    expect(counts.merchantPayoutsPending).toBe(0)
  })
})
