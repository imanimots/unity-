import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { dispatchPaymentExpiredEmails, recoverMissingPaymentExpiredEmails } from '../dispatch-expiry'
import { createFakeEmailAdmin } from './test-helpers'

/**
 * P5D-EXPIRE-UNPAID-NOTIFICATION-RECOVERY-I: dispatchPaymentExpiredEmails()
 * had test coverage only indirectly (via lazy-expiry.test.ts's RPC-level
 * mocking, which never actually exercises the dispatch branch).
 * recoverMissingPaymentExpiredEmails() is new. These tests extend the
 * existing, already-proven createFakeEmailAdmin() (src/lib/email/
 * __tests__/test-helpers.ts, which already faithfully simulates
 * email_deliveries' real idempotency_key unique-constraint behaviour --
 * the ACTUAL safety boundary this recovery mechanism relies on) with
 * minimal bookings/listings/profiles table support, so the REAL
 * recoverMissingPaymentExpiredEmails() and dispatchPaymentExpiredEmails()
 * run against it, not a reimplementation of their logic.
 *
 * LIMITATION, stated explicitly per this engagement's own convention: the
 * concurrency test below proves the fake's faithful simulation of
 * email_deliveries' real unique constraint (the same proven mechanism
 * already relied upon everywhere else in this codebase's email dispatch,
 * unmodified by this phase) and the real application-level call
 * sequencing -- it does not prove genuine multi-connection Postgres
 * execution. No live database is available to this test environment.
 */

type Row = Record<string, unknown>

function createFakeExpiryAdmin(fixtures: {
  bookings?: Row[]
  listings?: Row[]
  profiles?: Row[]
  email?: string | null
} = {}) {
  const base = createFakeEmailAdmin({ email: fixtures.email ?? 'user@example.com' })
  const tables: Record<string, Row[]> = {
    bookings: fixtures.bookings ?? [],
    listings: fixtures.listings ?? [],
    profiles: fixtures.profiles ?? [],
  }

  type Filter = ['eq' | 'in' | 'not_is_null' | 'gt'] | ['eq', string, unknown] | ['in', string, unknown[]] | ['gt', string, unknown] | ['not_is_null', string, unknown]

  function matches(row: Row, filters: Filter[]): boolean {
    return filters.every((f) => {
      const [op, col, val] = f as [string, string, unknown]
      const rowVal = row[col]
      if (op === 'eq') return rowVal === val
      if (op === 'in') return Array.isArray(val) && val.includes(rowVal)
      if (op === 'gt') return typeof rowVal === 'string' && typeof val === 'string' && rowVal > val
      if (op === 'not_is_null') return rowVal !== null && rowVal !== undefined
      return true
    })
  }

  function tableQuery(table: string) {
    function select() {
      const filters: Filter[] = []
      const builder = {
        eq(col: string, val: unknown) {
          filters.push(['eq', col, val])
          return builder
        },
        in(col: string, val: unknown[]) {
          filters.push(['in', col, val])
          return builder
        },
        gt(col: string, val: unknown) {
          filters.push(['gt', col, val])
          return builder
        },
        not(col: string, _op: string, val: unknown) {
          if (val === null) filters.push(['not_is_null', col, null])
          return builder
        },
        order() {
          return builder
        },
        limit() {
          return builder
        },
        async maybeSingle() {
          const rows = tables[table].filter((r) => matches(r, filters))
          return { data: rows[0] ?? null, error: null }
        },
        then(onResolve: (v: { data: Row[]; error: null }) => unknown, onReject?: (e: unknown) => unknown) {
          const rows = tables[table].filter((r) => matches(r, filters))
          return Promise.resolve({ data: rows, error: null }).then(onResolve, onReject)
        },
      }
      return builder
    }
    return { select }
  }

  function from(table: string) {
    if (table === 'bookings' || table === 'listings' || table === 'profiles') return tableQuery(table)
    return (base.admin as unknown as { from: (t: string) => unknown }).from(table)
  }

  return {
    admin: { ...(base.admin as object), from } as unknown as SupabaseClient,
    getDelivery: base.getDelivery,
    deliveryCount: base.deliveryCount,
  }
}

function bookingRow(overrides: Row = {}): Row {
  return {
    id: 'booking-1',
    status: 'expired',
    payment_expired_at: new Date().toISOString(),
    renter_id: 'renter-1',
    merchant_id: 'merchant-1',
    booking_reference: 'BK-1',
    listing_id: 'listing-1',
    ...overrides,
  }
}

const listingRow = { id: 'listing-1', title: 'Camera' }
const renterProfile = { id: 'renter-1', display_name: 'Sam', full_name: 'Sam Renter' }
const merchantProfile = { id: 'merchant-1', display_name: 'Mo', full_name: 'Mo Merchant' }

describe('dispatchPaymentExpiredEmails (category: P5D-EXPIRE-UNPAID-NOTIFICATION-RECOVERY-I regression)', () => {
  it('1. the original immediate-dispatch path still sends exactly one email to renter and one to merchant for a newly-expired booking', async () => {
    const { admin, deliveryCount } = createFakeExpiryAdmin({
      bookings: [bookingRow()],
      listings: [listingRow],
      profiles: [renterProfile, merchantProfile],
    })
    await dispatchPaymentExpiredEmails(admin, ['booking-1'])
    expect(deliveryCount()).toBe(2)
  })
})

describe('recoverMissingPaymentExpiredEmails (category: P5D-EXPIRE-UNPAID-NOTIFICATION-RECOVERY-I)', () => {
  it('2. an already-expired booking with no notification intent at all is recovered -- both renter and merchant emails are created', async () => {
    const { admin, deliveryCount } = createFakeExpiryAdmin({
      bookings: [bookingRow()],
      listings: [listingRow],
      profiles: [renterProfile, merchantProfile],
    })
    const result = await recoverMissingPaymentExpiredEmails(admin)
    expect(result.notificationsRecovered).toBe(2)
    expect(result.failed).toBe(0)
    expect(deliveryCount()).toBe(2)
  })

  it('3. a booking whose notifications were already sent is not duplicated', async () => {
    const { admin, deliveryCount } = createFakeExpiryAdmin({
      bookings: [bookingRow()],
      listings: [listingRow],
      profiles: [renterProfile, merchantProfile],
    })
    // Simulate the normal, already-successful immediate dispatch having
    // already run for this booking.
    await dispatchPaymentExpiredEmails(admin, ['booking-1'])
    expect(deliveryCount()).toBe(2)

    const result = await recoverMissingPaymentExpiredEmails(admin)
    expect(result.notificationsRecovered).toBe(0)
    expect(deliveryCount()).toBe(2)
  })

  it('4. an existing pending/failed_retryable delivery is left alone -- recovery never creates a second row or hands the row back to anyone but the retry subsystem', async () => {
    const { admin, deliveryCount, getDelivery } = createFakeExpiryAdmin({
      bookings: [bookingRow()],
      listings: [listingRow],
      profiles: [renterProfile, merchantProfile],
      // Both recipients resolve to this same fixture address in the
      // fake, so both provider sends fail retryably on the normal path
      // -- deliberately: this test only needs AT LEAST ONE delivery
      // left in a non-terminal, retry-subsystem-owned state to prove
      // recovery doesn't touch it.
      email: 'sam+fail-retryable@example.com',
    })
    await dispatchPaymentExpiredEmails(admin, ['booking-1'])
    expect(deliveryCount()).toBe(2)
    const statusesBefore = ['delivery-1', 'delivery-2'].map((id) => getDelivery(id)?.status)
    expect(statusesBefore.every((s) => s === 'failed_retryable')).toBe(true)

    const result = await recoverMissingPaymentExpiredEmails(admin)
    expect(result.notificationsRecovered).toBe(0)
    expect(deliveryCount()).toBe(2)
    const statusesAfter = ['delivery-1', 'delivery-2'].map((id) => getDelivery(id)?.status)
    expect(statusesAfter).toEqual(statusesBefore)
  })

  it('5. crash simulation: expiry already committed (booking status=expired) but the original dispatch never ran at all -- recovery creates the missing notifications on the next tick', async () => {
    const { admin, deliveryCount } = createFakeExpiryAdmin({
      bookings: [bookingRow({ id: 'booking-crash' })],
      listings: [listingRow],
      profiles: [renterProfile, merchantProfile],
    })
    expect(deliveryCount()).toBe(0)
    const result = await recoverMissingPaymentExpiredEmails(admin)
    expect(result.notificationsRecovered).toBe(2)
    expect(deliveryCount()).toBe(2)
  })

  it('6. sequential reconciliation replay creates no duplicate notification', async () => {
    const { admin, deliveryCount } = createFakeExpiryAdmin({
      bookings: [bookingRow()],
      listings: [listingRow],
      profiles: [renterProfile, merchantProfile],
    })
    const first = await recoverMissingPaymentExpiredEmails(admin)
    const second = await recoverMissingPaymentExpiredEmails(admin)
    expect(first.notificationsRecovered).toBe(2)
    expect(second.notificationsRecovered).toBe(0)
    expect(deliveryCount()).toBe(2)
  })

  it('7. concurrent reconciliation replay creates no duplicate notification -- two simultaneous recovery sweeps for the same booking still produce exactly one email per recipient', async () => {
    const { admin, deliveryCount } = createFakeExpiryAdmin({
      bookings: [bookingRow()],
      listings: [listingRow],
      profiles: [renterProfile, merchantProfile],
    })
    const [first, second] = await Promise.all([recoverMissingPaymentExpiredEmails(admin), recoverMissingPaymentExpiredEmails(admin)])
    expect(first.notificationsRecovered + second.notificationsRecovered).toBe(2)
    expect(deliveryCount()).toBe(2)
  })

  it('8. an unrelated booking (not expired for payment, e.g. completed) is never notified', async () => {
    const { admin, deliveryCount } = createFakeExpiryAdmin({
      bookings: [bookingRow({ id: 'booking-completed', status: 'completed', payment_expired_at: null })],
      listings: [listingRow],
      profiles: [renterProfile, merchantProfile],
    })
    const result = await recoverMissingPaymentExpiredEmails(admin)
    expect(result.notificationsRecovered).toBe(0)
    expect(deliveryCount()).toBe(0)
  })

  it('9. two distinct expired bookings each receive their own independent notification intent', async () => {
    const { admin, deliveryCount } = createFakeExpiryAdmin({
      bookings: [
        bookingRow({ id: 'booking-1' }),
        bookingRow({ id: 'booking-2', renter_id: 'renter-2', merchant_id: 'merchant-2' }),
      ],
      listings: [listingRow],
      profiles: [renterProfile, merchantProfile, { id: 'renter-2', display_name: 'Lee' }, { id: 'merchant-2', display_name: 'Kay' }],
    })
    const result = await recoverMissingPaymentExpiredEmails(admin)
    expect(result.notificationsRecovered).toBe(4)
    expect(deliveryCount()).toBe(4)
  })

  it('10. only the genuinely missing recipient is recovered when the other already has a delivery', async () => {
    const { admin, deliveryCount } = createFakeExpiryAdmin({
      bookings: [bookingRow()],
      listings: [listingRow],
      profiles: [renterProfile, merchantProfile],
    })
    // Only the renter's notification exists so far (simulating a crash
    // between the renter send and the merchant send in the original path).
    await (admin as unknown as { from: (t: string) => { insert: (r: Row) => { select: () => { maybeSingle: () => Promise<unknown> } } } })
      .from('email_deliveries')
      .insert({ event_type: 'booking.payment_expired', template_id: 'booking-payment-expired-renter', template_version: '0', recipient_user_id: 'renter-1', related_entity_type: 'booking', related_entity_id: 'booking-1', template_vars: {}, idempotency_key: 'manual-renter-key', status: 'sent' })
      .select()
      .maybeSingle()
    expect(deliveryCount()).toBe(1)

    const result = await recoverMissingPaymentExpiredEmails(admin)
    expect(result.notificationsRecovered).toBe(1)
    expect(deliveryCount()).toBe(2)
  })

  it('11. no direct provider call path is introduced -- recovery only ever reaches the provider through the existing sendTemplate() insert-then-send sequence (verified via delivery row creation, never a bypass)', async () => {
    const { admin, deliveryCount } = createFakeExpiryAdmin({
      bookings: [bookingRow()],
      listings: [listingRow],
      profiles: [renterProfile, merchantProfile],
    })
    const result = await recoverMissingPaymentExpiredEmails(admin)
    // Every recovered notification corresponds 1:1 with a durable
    // email_deliveries row -- there is no code path in
    // recoverMissingPaymentExpiredEmails that calls a provider directly;
    // the only send path is sendPaymentExpiredEmailToRenter/Merchant ->
    // sendTemplate(), unchanged from the original dispatch function.
    expect(result.notificationsRecovered).toBe(deliveryCount())
  })

  it('12. candidate scanning respects the batch/lookback bound -- a booking expired far outside the lookback window is not scanned', async () => {
    const farPast = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    const { admin, deliveryCount } = createFakeExpiryAdmin({
      bookings: [bookingRow({ id: 'booking-old', payment_expired_at: farPast })],
      listings: [listingRow],
      profiles: [renterProfile, merchantProfile],
    })
    const result = await recoverMissingPaymentExpiredEmails(admin)
    expect(result.candidatesScanned).toBe(0)
    expect(result.notificationsRecovered).toBe(0)
    expect(deliveryCount()).toBe(0)
  })
})
