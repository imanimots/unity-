import { describe, it, expect, vi } from 'vitest'
import { listAdminBookings, getAdminBookingDetail } from '../operations-service'

vi.mock('@/lib/checkout/load-financial-state', () => ({
  loadBookingFinancialState: vi.fn().mockResolvedValue({ booking: null, workflowStatus: null, rentalPaymentStatus: null, depositPaymentStatus: null }),
}))

interface RecordedCall {
  method: string
  args: unknown[]
}

function fakeListQuery(calls: RecordedCall[]) {
  const obj: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'or', 'order', 'limit', 'in']) {
    obj[method] = (...args: unknown[]) => {
      calls.push({ method, args })
      return obj
    }
  }
  obj.then = (resolve: (v: { data: unknown[]; error: null }) => void) => resolve({ data: [], error: null })
  return obj
}

describe('operations-service: listAdminBookings real-data scope (category: ADMIN-CONTROL-CENTRE-BATCH-D3-D)', () => {
  it('1. filters the embedded listing is_test=false and both renter/merchant profile data_classification=\'real\' -- positive equality, at the query level', async () => {
    const calls: RecordedCall[] = []
    const admin = { from: () => fakeListQuery(calls) } as unknown as Parameters<typeof listAdminBookings>[0]
    await listAdminBookings(admin, {})
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'listings.is_test' && c.args[1] === false)).toBe(true)
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'renter_profile.data_classification' && c.args[1] === 'real')).toBe(true)
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'merchant_profile.data_classification' && c.args[1] === 'real')).toBe(true)
  })

  it('2. the real-data filter composes with an existing status filter, not replaces it', async () => {
    const calls: RecordedCall[] = []
    const admin = { from: () => fakeListQuery(calls) } as unknown as Parameters<typeof listAdminBookings>[0]
    await listAdminBookings(admin, { status: 'active' })
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'renter_profile.data_classification')).toBe(true)
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'status' && c.args[1] === 'active')).toBe(true)
  })

  it('3. zero real bookings returns an empty array without throwing', async () => {
    const admin = { from: () => fakeListQuery([]) } as unknown as Parameters<typeof listAdminBookings>[0]
    const rows = await listAdminBookings(admin, {})
    expect(rows).toEqual([])
  })
})

/** Generic query stub for getAdminBookingDetail's fan-out beyond the profile/booking checks under test. */
function fakeBookingDetailAdmin(bookingRow: Record<string, unknown> | null, profileRows: Record<string, unknown>[]) {
  const bookingQuery: Record<string, unknown> = {}
  for (const method of ['select', 'eq']) bookingQuery[method] = () => bookingQuery
  bookingQuery.maybeSingle = () => Promise.resolve({ data: bookingRow, error: null })

  const profilesQuery: Record<string, unknown> = {}
  for (const method of ['select', 'in']) profilesQuery[method] = () => profilesQuery
  profilesQuery.then = (resolve: (v: { data: typeof profileRows; error: null }) => void) => resolve({ data: profileRows, error: null })

  const empty: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'order']) empty[method] = () => empty
  empty.then = (resolve: (v: { data: unknown[]; error: null }) => void) => resolve({ data: [], error: null })

  return {
    from: (table: string) => {
      if (table === 'bookings') return bookingQuery
      if (table === 'profiles') return profilesQuery
      return empty
    },
  } as unknown as Parameters<typeof getAdminBookingDetail>[0]
}

describe('operations-service: getAdminBookingDetail real-data scope (category: ADMIN-CONTROL-CENTRE-BATCH-D3-D)', () => {
  const baseBooking = {
    id: 'bk1', booking_reference: 'BK-1', listing_id: 'l1', renter_id: 'r1', merchant_id: 'm1',
    status: 'active', start_at: null, end_at: null, payment_due_at: null, created_at: '2026-01-01T00:00:00Z',
    subtotal_amount: 100, deposit_amount_snapshot: 0, renter_total_amount: 100, currency: 'ZAR',
    listings: { title: 'Camera', is_test: false },
  }

  it('4. real renter + real merchant + non-test listing resolves normally', async () => {
    const admin = fakeBookingDetailAdmin(baseBooking, [
      { id: 'r1', full_name: 'Renter', display_name: null, account_status: 'active', data_classification: 'real' },
      { id: 'm1', full_name: 'Merchant', display_name: null, account_status: 'active', data_classification: 'real' },
    ])
    const detail = await getAdminBookingDetail(admin, 'bk1')
    expect(detail).not.toBeNull()
    expect(detail?.booking.id).toBe('bk1')
  })

  it('5. a test-classified renter blocks the whole booking from Real Data detail, even though the merchant is real', async () => {
    const admin = fakeBookingDetailAdmin(baseBooking, [
      { id: 'r1', full_name: 'Renter', display_name: null, account_status: 'active', data_classification: 'test' },
      { id: 'm1', full_name: 'Merchant', display_name: null, account_status: 'active', data_classification: 'real' },
    ])
    const detail = await getAdminBookingDetail(admin, 'bk1')
    expect(detail).toBeNull()
  })

  it('6. an unknown-classified merchant blocks the whole booking, even though the renter is real', async () => {
    const admin = fakeBookingDetailAdmin(baseBooking, [
      { id: 'r1', full_name: 'Renter', display_name: null, account_status: 'active', data_classification: 'real' },
      { id: 'm1', full_name: 'Merchant', display_name: null, account_status: 'active', data_classification: 'unknown' },
    ])
    const detail = await getAdminBookingDetail(admin, 'bk1')
    expect(detail).toBeNull()
  })

  it('7. an is_test=true listing blocks the booking even when both participants are real', async () => {
    const admin = fakeBookingDetailAdmin(
      { ...baseBooking, listings: { title: 'Camera', is_test: true } },
      [
        { id: 'r1', full_name: 'Renter', display_name: null, account_status: 'active', data_classification: 'real' },
        { id: 'm1', full_name: 'Merchant', display_name: null, account_status: 'active', data_classification: 'real' },
      ]
    )
    const detail = await getAdminBookingDetail(admin, 'bk1')
    expect(detail).toBeNull()
  })

  it('8. a missing booking row still returns null (pre-existing behavior preserved)', async () => {
    const admin = fakeBookingDetailAdmin(null, [])
    const detail = await getAdminBookingDetail(admin, 'missing')
    expect(detail).toBeNull()
  })
})
