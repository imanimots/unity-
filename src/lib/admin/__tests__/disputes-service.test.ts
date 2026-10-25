import { describe, it, expect, vi } from 'vitest'
import { countAdminDisputesForUser, listAdminDisputes } from '../disputes-service'

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
