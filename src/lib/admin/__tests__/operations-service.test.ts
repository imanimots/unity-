import { describe, it, expect, vi } from 'vitest'
import { listAdminBookings, getAdminBookingDetail, getRealBookingOverviewCounts, listFinancialOperations } from '../operations-service'
import { encodeKeysetCursor, computeCursorContextHash } from '../cursor'

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

/**
 * D3-D-F1: fake admin for getRealBookingOverviewCounts. `countByStatus`
 * maps a status value to the head:true count the mocked query should
 * resolve to; `acceptedRows`/`capturedBookingIds` drive the
 * accepted_awaiting_payment_bookings/financially_ready_bookings
 * EXISTS-replacement (fetch accepted real-scoped booking ids, then a
 * single batched `payments` lookup -- never per-row).
 */
function fakeBookingOverviewAdmin(countByStatus: Record<string, number>, acceptedRows: { id: string }[], capturedBookingIds: string[]) {
  return {
    from: (table: string) => {
      if (table === 'bookings') {
        let lastStatus: string | undefined
        const obj: Record<string, unknown> = {}
        let isHead = false
        obj.select = (_cols: string, opts?: { head?: boolean }) => {
          isHead = !!opts?.head
          return obj
        }
        for (const method of ['not', 'lt', 'is']) obj[method] = () => obj
        obj.eq = (col: string, val: unknown) => {
          if (col === 'status') lastStatus = val as string
          return obj
        }
        obj.then = (resolve: (v: { count?: number; data?: { id: string }[]; error: null }) => void) => {
          if (isHead) {
            resolve({ count: lastStatus ? countByStatus[lastStatus] ?? 0 : 0, error: null })
          } else {
            resolve({ data: acceptedRows, error: null })
          }
        }
        return obj
      }
      if (table === 'payments') {
        const obj: Record<string, unknown> = {}
        for (const method of ['select', 'eq', 'in']) obj[method] = () => obj
        obj.then = (resolve: (v: { data: { booking_id: string }[]; error: null }) => void) =>
          resolve({ data: capturedBookingIds.map((id) => ({ booking_id: id })), error: null })
        return obj
      }
      throw new Error(`unexpected table: ${table}`)
    },
  } as unknown as Parameters<typeof getRealBookingOverviewCounts>[0]
}

describe('operations-service: getRealBookingOverviewCounts (category: ADMIN-CONTROL-CENTRE-BATCH-D3-D-F1)', () => {
  it('9. requested/active/overdue counts reflect the scoped query results exactly', async () => {
    const admin = fakeBookingOverviewAdmin({ requested: 3, active: 7, accepted: 0 }, [], [])
    const counts = await getRealBookingOverviewCounts(admin)
    expect(counts.requestedBookings).toBe(3)
    expect(counts.activeRentals).toBe(7)
  })

  it('10. financially_ready_bookings counts only accepted bookings with a captured rental_charge payment; the rest are accepted_awaiting_payment_bookings -- the split always sums to the total accepted count', async () => {
    const admin = fakeBookingOverviewAdmin({}, [{ id: 'bk1' }, { id: 'bk2' }, { id: 'bk3' }], ['bk1', 'bk3'])
    const counts = await getRealBookingOverviewCounts(admin)
    expect(counts.financiallyReadyBookings).toBe(2)
    expect(counts.acceptedAwaitingPaymentBookings).toBe(1)
    expect(counts.financiallyReadyBookings + counts.acceptedAwaitingPaymentBookings).toBe(3)
  })

  it('11. zero accepted real bookings never queries payments and returns 0/0 safely', async () => {
    const admin = fakeBookingOverviewAdmin({}, [], [])
    const counts = await getRealBookingOverviewCounts(admin)
    expect(counts.financiallyReadyBookings).toBe(0)
    expect(counts.acceptedAwaitingPaymentBookings).toBe(0)
  })

  it('12. a null/undefined count resolves to 0, never undefined/NaN', async () => {
    const admin = fakeBookingOverviewAdmin({}, [], [])
    const counts = await getRealBookingOverviewCounts(admin)
    expect(counts.requestedBookings).toBe(0)
    expect(counts.activeRentals).toBe(0)
    expect(counts.overduePaymentDeadlines).toBe(0)
  })
})

interface RpcCall {
  fn: string
  args: unknown
}

function fakeFinOpsAdmin(
  rpcRows: Record<string, unknown>[],
  tables: Record<string, Record<string, unknown>[]> = {},
  rpcCalls: RpcCall[] = []
) {
  return {
    rpc: (fn: string, args: unknown) => {
      rpcCalls.push({ fn, args })
      return Promise.resolve({ data: rpcRows, error: null })
    },
    from: (table: string) => {
      const rows = tables[table] ?? []
      let filters: Record<string, unknown> = {}
      const obj: Record<string, unknown> = {
        select: () => obj,
        in: (col: string, vals: unknown[]) => {
          filters = { ...filters, [col]: vals }
          return obj
        },
        then: (resolve: (v: { data: Record<string, unknown>[]; error: null }) => void) => {
          const matched = rows.filter((r) => Object.entries(filters).every(([k, v]) => (v as unknown[]).includes(r[k])))
          resolve({ data: matched, error: null })
        },
      }
      return obj
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

describe('operations-service: listFinancialOperations real-data scope (category: ADMIN-CONTROL-CENTRE-BATCH-D3-E-F1)', () => {
  it('1. calls the Real-Data-scoped RPC with the status filter and a null cursor on the first page', async () => {
    const rpcCalls: RpcCall[] = []
    const admin = fakeFinOpsAdmin([], {}, rpcCalls)
    await listFinancialOperations(admin, { status: 'captured' })
    expect(rpcCalls[0].fn).toBe('_admin_list_financial_operations')
    expect(rpcCalls[0].args).toMatchObject({ p_status: 'captured', p_cursor_ts: null, p_cursor_id: null })
  })

  it('2. a booking-linked row resolves booking fields, workflow/payout status, and leaves order/barter/RTB fields null', async () => {
    const admin = fakeFinOpsAdmin(
      [
        {
          id: 'p1', booking_id: 'bk1', booking_reference: 'BK-1', order_id: null, order_reference: null,
          barter_agreement_id: null, barter_agreement_reference: null, rent_to_buy_agreement_id: null,
          payment_type: 'rental_charge', status: 'captured', amount: 100, currency: 'ZAR', failure_reason: null, requested_at: '2026-01-01T00:00:00Z',
        },
      ],
      {
        financial_workflows: [{ booking_id: 'bk1', status: 'completed' }],
        ledger_entries: [{ payment_id: 'p1' }, { payment_id: 'p1' }],
        merchant_payouts: [{ booking_id: 'bk1', status: 'paid' }],
      }
    )
    const { operations } = await listFinancialOperations(admin, {})
    expect(operations).toEqual([
      expect.objectContaining({
        paymentId: 'p1', bookingId: 'bk1', bookingReference: 'BK-1',
        orderId: null, orderReference: null, barterAgreementId: null, barterAgreementReference: null,
        rentToBuyAgreementId: null, rentToBuyReference: null,
        workflowStatus: 'completed', ledgerEntryCount: 2, payoutStatus: 'paid',
      }),
    ])
  })

  it('3. a barter-linked row displays its own agreement reference rather than a blank booking/order field, with payoutStatus not_applicable', async () => {
    const admin = fakeFinOpsAdmin([
      {
        id: 'p2', booking_id: null, booking_reference: null, order_id: null, order_reference: null,
        barter_agreement_id: 'ba1', barter_agreement_reference: 'BA-1', rent_to_buy_agreement_id: null,
        payment_type: 'barter_deposit', status: 'captured', amount: 50, currency: 'ZAR', failure_reason: null, requested_at: '2026-01-01T00:00:00Z',
      },
    ])
    const { operations } = await listFinancialOperations(admin, {})
    expect(operations[0]).toMatchObject({
      barterAgreementId: 'ba1', barterAgreementReference: 'BA-1', bookingReference: null, orderReference: null,
      workflowStatus: null, payoutStatus: 'not_applicable',
    })
  })

  it('4. a rent-to-buy-linked row synthesizes an RTB-XXXXXXXX reference and a failed status derives a failed failureCategory', async () => {
    const admin = fakeFinOpsAdmin([
      {
        id: 'p3', booking_id: null, booking_reference: null, order_id: null, order_reference: null,
        barter_agreement_id: null, barter_agreement_reference: null, rent_to_buy_agreement_id: 'rtb-abcdef12',
        payment_type: 'rent_to_buy_installment', status: 'failed', amount: 200, currency: 'ZAR', failure_reason: 'card_declined', requested_at: '2026-01-01T00:00:00Z',
      },
    ])
    const { operations } = await listFinancialOperations(admin, {})
    expect(operations[0]).toMatchObject({
      rentToBuyAgreementId: 'rtb-abcdef12', rentToBuyReference: 'RTB-RTB-ABCD', failureCategory: 'failed', payoutStatus: 'not_applicable',
    })
  })

  it('5. zero rows returns an empty, well-formed page without querying any enrichment table', async () => {
    const admin = fakeFinOpsAdmin([])
    const page = await listFinancialOperations(admin, {})
    expect(page).toEqual({ operations: [], hasMore: false, nextCursor: null })
  })

  it('6. hasMore/nextCursor are derived from the extra fetched row, same as before, and the cursor is bound to the status filter context', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({
      id: `p${i}`, booking_id: null, booking_reference: null, order_id: `o${i}`, order_reference: `ORD-${i}`,
      barter_agreement_id: null, barter_agreement_reference: null, rent_to_buy_agreement_id: null,
      payment_type: 'order_payment', status: 'captured', amount: 10, currency: 'ZAR', failure_reason: null, requested_at: `2026-01-0${3 - i}T00:00:00Z`,
    }))
    const admin = fakeFinOpsAdmin(rows)
    const page = await listFinancialOperations(admin, { limit: 2 })
    expect(page.hasMore).toBe(true)
    expect(page.operations).toHaveLength(2)
    expect(page.nextCursor).toBe(
      encodeKeysetCursor({ ts: '2026-01-02T00:00:00Z', id: 'p1', contextHash: computeCursorContextHash('admin_financial_operations', { status: null }) })
    )
  })

  it('7. a prior cursor is decoded and forwarded to the RPC as p_cursor_ts/p_cursor_id', async () => {
    const rpcCalls: RpcCall[] = []
    const cursor = encodeKeysetCursor({ ts: '2026-01-01T00:00:00Z', id: 'p9', contextHash: computeCursorContextHash('admin_financial_operations', { status: null }) })
    const admin = fakeFinOpsAdmin([], {}, rpcCalls)
    await listFinancialOperations(admin, { cursor })
    expect(rpcCalls[0].args).toMatchObject({ p_cursor_ts: '2026-01-01T00:00:00Z', p_cursor_id: 'p9' })
  })
})
