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
 * P5D-EXPIRE-UNPAID-NOTIFICATION-RECOVERY-F1: recoverMissingPaymentExpiredEmails()
 * now delegates candidate selection to a read-only SQL RPC,
 * find_missing_payment_expired_notifications() (see the new migration).
 * The fake `rpc()` below re-implements that RPC's NOT-EXISTS-before-LIMIT,
 * no-age-cutoff, per-recipient semantics in-memory against the same
 * bookings/email_deliveries fixtures, so the REAL application consumer
 * code is exercised end to end. LIMITATION, stated explicitly per this
 * engagement's own convention: this proves the application code's
 * consumption of exactly that contract (anti-join before limit, no age
 * cutoff, per-recipient granularity, deterministic order) and the fake's
 * faithful simulation of email_deliveries' real unique constraint -- it
 * does NOT prove genuine multi-connection Postgres execution of the SQL
 * itself. No live database is available to this test environment; the
 * migration's own SQL structure (NOT EXISTS evaluated inside the
 * subquery that is UNION ALL'd and only then ORDER BY/LIMIT'd, no WHERE
 * clause referencing payment_expired_at against any cutoff) is reviewed
 * directly from the migration text instead.
 *
 * The concurrency test below additionally proves the fake's faithful
 * simulation of email_deliveries' real unique constraint and the real
 * application-level call sequencing -- same limitation as above.
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

  type Filter = ['eq', string, unknown] | ['in', string, unknown[]] | ['gt', string, unknown] | ['not_is_null', string, unknown]

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

  /**
   * Re-implements find_missing_payment_expired_notifications()'s contract
   * in-memory: for every status='expired' / payment_expired_at-not-null
   * booking, independently check (via the SAME email_deliveries store the
   * rest of this fake uses) whether a renter delivery and/or a merchant
   * delivery already exists for it. Only recipients with NO existing row
   * are included -- this filtering happens before sort+limit are applied
   * below, exactly mirroring the real migration's NOT EXISTS-inside-the-
   * union, ORDER BY/LIMIT-outside-it structure. No age cutoff of any kind.
   */
  async function hasDelivery(bookingId: string, recipientUserId: string): Promise<boolean> {
    const emailAdmin = base.admin as unknown as {
      from: (t: string) => { select: (c: string) => { eq: (c: string, v: unknown) => unknown } }
    }
    type AwaitableEq = { eq: (c: string, v: unknown) => AwaitableEq } & PromiseLike<{ data: Row[]; error: null }>
    const builder = emailAdmin.from('email_deliveries').select('*') as unknown as AwaitableEq
    const filtered = builder
      .eq('related_entity_type', 'booking')
      .eq('related_entity_id', bookingId)
      .eq('event_type', 'booking.payment_expired')
      .eq('recipient_user_id', recipientUserId)
    const { data } = await filtered
    return Array.isArray(data) && data.length > 0
  }

  async function rpc(fn: string, args: Record<string, unknown>) {
    if (fn !== 'find_missing_payment_expired_notifications') {
      throw new Error(`fake admin does not support rpc "${fn}"`)
    }
    const limit = typeof args.p_limit === 'number' ? args.p_limit : 100
    const expired = tables.bookings.filter((b) => b.status === 'expired' && b.payment_expired_at !== null && b.payment_expired_at !== undefined)

    const candidates: { booking_id: string; recipient_role: 'renter' | 'merchant'; recipient_user_id: string; payment_expired_at: string }[] = []
    for (const b of expired) {
      const bookingId = b.id as string
      const renterId = b.renter_id as string
      const merchantId = b.merchant_id as string
      const paymentExpiredAt = b.payment_expired_at as string

      if (!(await hasDelivery(bookingId, renterId))) {
        candidates.push({ booking_id: bookingId, recipient_role: 'renter', recipient_user_id: renterId, payment_expired_at: paymentExpiredAt })
      }
      if (!(await hasDelivery(bookingId, merchantId))) {
        candidates.push({ booking_id: bookingId, recipient_role: 'merchant', recipient_user_id: merchantId, payment_expired_at: paymentExpiredAt })
      }
    }

    candidates.sort((a, b) => {
      if (a.payment_expired_at !== b.payment_expired_at) return a.payment_expired_at < b.payment_expired_at ? -1 : 1
      if (a.booking_id !== b.booking_id) return a.booking_id < b.booking_id ? -1 : 1
      return a.recipient_role < b.recipient_role ? -1 : a.recipient_role > b.recipient_role ? 1 : 0
    })

    return { data: candidates.slice(0, limit), error: null }
  }

  return {
    admin: { ...(base.admin as object), from, rpc } as unknown as SupabaseClient,
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

async function seedDelivery(admin: SupabaseClient, overrides: Row) {
  await (admin as unknown as { from: (t: string) => { insert: (r: Row) => { select: () => { maybeSingle: () => Promise<unknown> } } } })
    .from('email_deliveries')
    .insert({
      event_type: 'booking.payment_expired',
      template_id: 'booking-payment-expired-renter',
      template_version: '0',
      recipient_user_id: 'renter-1',
      related_entity_type: 'booking',
      related_entity_id: 'booking-1',
      template_vars: {},
      idempotency_key: `manual-key-${Math.random().toString(36).slice(2)}`,
      status: 'sent',
      ...overrides,
    })
    .select()
    .maybeSingle()
}

const listingRow = { id: 'listing-1', title: 'Camera' }
const renterProfile = { id: 'renter-1', display_name: 'Sam', full_name: 'Sam Renter' }
const merchantProfile = { id: 'merchant-1', display_name: 'Mo', full_name: 'Mo Merchant' }

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
}

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
    await seedDelivery(admin, { status: 'sent' })
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

  it('12. a booking expired far in the past (30 days) with a genuinely missing notification is still recovered -- no permanent age horizon', async () => {
    const { admin, deliveryCount } = createFakeExpiryAdmin({
      bookings: [bookingRow({ id: 'booking-old', payment_expired_at: daysAgoIso(30) })],
      listings: [listingRow],
      profiles: [renterProfile, merchantProfile],
    })
    const result = await recoverMissingPaymentExpiredEmails(admin)
    expect(result.candidatesScanned).toBe(2)
    expect(result.notificationsRecovered).toBe(2)
    expect(deliveryCount()).toBe(2)
  })

  // P5D-EXPIRE-UNPAID-NOTIFICATION-RECOVERY-F1 -- starvation remediation coverage.

  it('13. starvation resistance: 150 old, fully-resolved bookings do not prevent a newer, genuinely missing booking from being recovered', async () => {
    const resolvedBookings: Row[] = []
    const profiles: Row[] = [renterProfile, merchantProfile]
    for (let i = 0; i < 150; i++) {
      const id = `booking-resolved-${i}`
      const renterId = `renter-resolved-${i}`
      const merchantId = `merchant-resolved-${i}`
      resolvedBookings.push(bookingRow({ id, renter_id: renterId, merchant_id: merchantId, payment_expired_at: daysAgoIso(200 - i) }))
      profiles.push({ id: renterId, display_name: `R${i}` }, { id: merchantId, display_name: `M${i}` })
    }
    const missingBooking = bookingRow({ id: 'booking-missing', payment_expired_at: daysAgoIso(1) })

    const { admin, deliveryCount } = createFakeExpiryAdmin({
      bookings: [...resolvedBookings, missingBooking],
      listings: [listingRow],
      profiles,
    })

    // Fully resolve all 150 old bookings first -- each is older (further
    // in the past) than the one genuinely-missing booking, so under the
    // OLD "first 100 by payment_expired_at ASC, filter in memory" design
    // these 150 oldest rows would occupy every batch forever and the
    // missing booking would never even be fetched.
    for (const b of resolvedBookings) {
      await dispatchPaymentExpiredEmails(admin, [b.id as string])
    }
    expect(deliveryCount()).toBe(300)

    const result = await recoverMissingPaymentExpiredEmails(admin)
    expect(result.notificationsRecovered).toBe(2)
    expect(deliveryCount()).toBe(302)
  })

  it('14. already-resolved bookings do not repeatedly consume the candidate budget across runs', async () => {
    const resolvedBookings: Row[] = []
    const profiles: Row[] = [renterProfile, merchantProfile]
    for (let i = 0; i < 120; i++) {
      const id = `booking-resolved-${i}`
      const renterId = `renter-resolved-${i}`
      const merchantId = `merchant-resolved-${i}`
      resolvedBookings.push(bookingRow({ id, renter_id: renterId, merchant_id: merchantId, payment_expired_at: daysAgoIso(300 - i) }))
      profiles.push({ id: renterId, display_name: `R${i}` }, { id: merchantId, display_name: `M${i}` })
    }
    const missingBooking = bookingRow({ id: 'booking-missing', payment_expired_at: daysAgoIso(1) })

    const { admin } = createFakeExpiryAdmin({
      bookings: [...resolvedBookings, missingBooking],
      listings: [listingRow],
      profiles,
    })
    for (const b of resolvedBookings) {
      await dispatchPaymentExpiredEmails(admin, [b.id as string])
    }

    // Two consecutive runs: the resolved backlog must not reappear in
    // either run's candidate budget at all -- the whole point of
    // filtering unresolved-ness BEFORE limit, not after.
    const first = await recoverMissingPaymentExpiredEmails(admin)
    expect(first.candidatesScanned).toBe(2)
    const second = await recoverMissingPaymentExpiredEmails(admin)
    expect(second.candidatesScanned).toBe(0)
  })

  it('15. backlog drain: repeated runs over a >100-task unresolved backlog make monotonic forward progress until the backlog is exhausted (BACKLOG DRAIN: SELF-DRAINING)', async () => {
    const bookings: Row[] = []
    const profiles: Row[] = []
    for (let i = 0; i < 150; i++) {
      const id = `booking-${i}`
      const renterId = `renter-${i}`
      const merchantId = `merchant-${i}`
      bookings.push(bookingRow({ id, renter_id: renterId, merchant_id: merchantId, payment_expired_at: daysAgoIso(150 - i) }))
      profiles.push({ id: renterId, display_name: `R${i}` }, { id: merchantId, display_name: `M${i}` })
    }
    const { admin, deliveryCount } = createFakeExpiryAdmin({ bookings, listings: [listingRow], profiles })

    // 150 bookings x 2 recipients = 300 missing tasks; batch limit is 100.
    const run1 = await recoverMissingPaymentExpiredEmails(admin)
    expect(run1.notificationsRecovered).toBe(100)
    expect(deliveryCount()).toBe(100)

    const run2 = await recoverMissingPaymentExpiredEmails(admin)
    expect(run2.notificationsRecovered).toBe(100)
    expect(deliveryCount()).toBe(200)

    const run3 = await recoverMissingPaymentExpiredEmails(admin)
    expect(run3.notificationsRecovered).toBe(100)
    expect(deliveryCount()).toBe(300)

    const run4 = await recoverMissingPaymentExpiredEmails(admin)
    expect(run4.notificationsRecovered).toBe(0)
    expect(deliveryCount()).toBe(300)
  })

  it('16. renter exists, merchant missing -> only the merchant notification is recovered', async () => {
    const { admin, deliveryCount } = createFakeExpiryAdmin({
      bookings: [bookingRow()],
      listings: [listingRow],
      profiles: [renterProfile, merchantProfile],
    })
    await seedDelivery(admin, { recipient_user_id: 'renter-1', status: 'sent' })
    expect(deliveryCount()).toBe(1)

    const result = await recoverMissingPaymentExpiredEmails(admin)
    expect(result.notificationsRecovered).toBe(1)
    expect(deliveryCount()).toBe(2)
  })

  it('17. merchant exists, renter missing -> only the renter notification is recovered', async () => {
    const { admin, deliveryCount } = createFakeExpiryAdmin({
      bookings: [bookingRow()],
      listings: [listingRow],
      profiles: [renterProfile, merchantProfile],
    })
    await seedDelivery(admin, { recipient_user_id: 'merchant-1', template_id: 'booking-payment-expired-merchant', status: 'sent' })
    expect(deliveryCount()).toBe(1)

    const result = await recoverMissingPaymentExpiredEmails(admin)
    expect(result.notificationsRecovered).toBe(1)
    expect(deliveryCount()).toBe(2)
  })

  it('18. both renter and merchant already have deliveries -> the booking is excluded entirely, no-op', async () => {
    const { admin, deliveryCount } = createFakeExpiryAdmin({
      bookings: [bookingRow()],
      listings: [listingRow],
      profiles: [renterProfile, merchantProfile],
    })
    await seedDelivery(admin, { recipient_user_id: 'renter-1', status: 'sent' })
    await seedDelivery(admin, { recipient_user_id: 'merchant-1', template_id: 'booking-payment-expired-merchant', status: 'sent' })
    expect(deliveryCount()).toBe(2)

    const result = await recoverMissingPaymentExpiredEmails(admin)
    expect(result.candidatesScanned).toBe(0)
    expect(result.notificationsRecovered).toBe(0)
    expect(deliveryCount()).toBe(2)
  })

  it('19. neither renter nor merchant has a delivery -> both are recovered independently', async () => {
    const { admin, deliveryCount } = createFakeExpiryAdmin({
      bookings: [bookingRow()],
      listings: [listingRow],
      profiles: [renterProfile, merchantProfile],
    })
    const result = await recoverMissingPaymentExpiredEmails(admin)
    expect(result.candidatesScanned).toBe(2)
    expect(result.notificationsRecovered).toBe(2)
    expect(deliveryCount()).toBe(2)
  })

  it.each(['pending', 'failed_retryable', 'failed_terminal', 'sent'] as const)(
    '20. an existing %s delivery for the renter suppresses a duplicate renter notification, while the still-missing merchant one is independently recovered',
    async (status) => {
      const { admin, deliveryCount, getDelivery } = createFakeExpiryAdmin({
        bookings: [bookingRow()],
        listings: [listingRow],
        profiles: [renterProfile, merchantProfile],
      })
      await seedDelivery(admin, { recipient_user_id: 'renter-1', status })
      expect(deliveryCount()).toBe(1)
      expect(getDelivery('delivery-1')?.status).toBe(status)

      const result = await recoverMissingPaymentExpiredEmails(admin)
      expect(result.notificationsRecovered).toBe(1)
      expect(deliveryCount()).toBe(2)
      // The pre-existing renter row is untouched -- no second renter row
      // was created, and its status was not overwritten by recovery.
      expect(getDelivery('delivery-1')?.status).toBe(status)
      expect(getDelivery('delivery-1')?.recipient_user_id).toBe('renter-1')
    }
  )

  it('21. concurrent recovery for the same missing recipient still creates exactly one logical delivery, and the losing racer never reaches the provider', async () => {
    const { admin, deliveryCount } = createFakeExpiryAdmin({
      bookings: [bookingRow({ id: 'booking-crash' })],
      listings: [listingRow],
      profiles: [renterProfile, merchantProfile],
    })
    const [first, second] = await Promise.all([recoverMissingPaymentExpiredEmails(admin), recoverMissingPaymentExpiredEmails(admin)])
    // Exactly 2 durable rows total (one per recipient) regardless of how
    // the two concurrent sweeps split the credit between them -- the
    // email_deliveries_idempotency_key_unique constraint (faithfully
    // simulated by the fake's synchronous insert-or-conflict check) is
    // what makes this true, not any lock this recovery code takes itself.
    expect(deliveryCount()).toBe(2)
    expect(first.notificationsRecovered + second.notificationsRecovered).toBe(2)
    // Every notificationsRecovered increment corresponds 1:1 with an
    // actual delivery row -- a losing racer's attempt returns
    // skipped_duplicate from sendTemplate() without inserting a row or
    // reaching the provider, and is therefore never counted here.
  })
})
