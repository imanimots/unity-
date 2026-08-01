import type { SupabaseClient } from '@supabase/supabase-js'
import { dispatchPaymentExpiredEmails } from '@/lib/email'

/**
 * The ONE centralized lazy-expiry trigger (Step 6) -- called from every
 * trusted read/write entry point that could otherwise show or act on a
 * stale "accepted" booking whose payment deadline has already passed
 * (checkout eligibility, booking detail, renter/merchant booking lists,
 * start-rental). Never scattered per-page logic: every call site just
 * awaits this, then re-reads booking state normally -- the actual
 * transition (and its concurrency-safety) lives entirely in the
 * expire_unpaid_accepted_bookings() RPC (see the Step 6 migration).
 *
 * Deliberately a full sweep, not a single-booking check: at MVP scale a
 * full scan of overdue accepted bookings is cheap, and reusing the exact
 * same trusted operation a future scheduler will call keeps this
 * "lazy path" and the "scheduled path" from ever drifting apart into two
 * different expiry behaviours. See docs/PAYMENT_READINESS.md
 * "Lazy expiry" and "Known limitations" for the scaling caveat.
 *
 * Step 8: the RPC now also returns the exact ids it just transitioned
 * (expired_booking_ids) -- used here to dispatch exactly one
 * booking.payment_expired email pair (renter + merchant) per newly
 * expired booking, never for a booking that was already expired before
 * this call.
 *
 * Errors are swallowed, not thrown -- a failed lazy-expiry attempt must
 * never turn an otherwise-successful read/action into a 500; the
 * booking's displayed state simply stays whatever it was a moment longer,
 * corrected on the next successful trigger (or the future scheduler).
 */
export interface LazyExpirySweepResult {
  expiredCount: number
  skippedReadyCount: number
}

/** Returns null on any failure (swallowed, never thrown) -- most call sites ignore the return value entirely; the internal cron route (src/app/api/internal/expire-unpaid-bookings) surfaces it for monitoring. */
export async function triggerLazyExpirySweep(admin: SupabaseClient): Promise<LazyExpirySweepResult | null> {
  try {
    const { data, error } = await admin.rpc('expire_unpaid_accepted_bookings')
    if (error) {
      console.error('[lazy-expiry] sweep RPC error', { error })
      return null
    }
    const expiredIds: string[] = data?.expired_booking_ids ?? []
    if (expiredIds.length > 0) {
      await dispatchPaymentExpiredEmails(admin, expiredIds)
    }
    return { expiredCount: data?.expired_count ?? expiredIds.length, skippedReadyCount: data?.skipped_ready_count ?? 0 }
  } catch (err) {
    console.error('[lazy-expiry] sweep failed', { err })
    return null
  }
}
