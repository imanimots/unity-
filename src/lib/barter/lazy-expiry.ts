import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Lazy-expiry trigger for stale barter proposals, mirroring
 * src/lib/bookings/lazy-expiry.ts's pattern -- called opportunistically
 * from the barter list route before reading, rather than requiring a
 * real scheduler. expire_stale_barter_proposals() returns a plain count
 * (not per-agreement ids, unlike the booking sweep), so there is no
 * per-agreement email dispatch here yet -- email templates are a later
 * phase; when they exist, a reminder/expiry email can be added the same
 * way dispatchPaymentExpiredEmails() was for bookings.
 *
 * Errors are swallowed, not thrown -- a failed sweep must never turn an
 * otherwise-successful read into a 500.
 */
export async function triggerBarterLazyExpirySweep(admin: SupabaseClient): Promise<number | null> {
  try {
    const { data, error } = await admin.rpc('expire_stale_barter_proposals')
    if (error) {
      console.error('[barter.lazy-expiry] sweep RPC error', { error })
      return null
    }
    return data ?? 0
  } catch (err) {
    console.error('[barter.lazy-expiry] sweep failed', { err })
    return null
  }
}
