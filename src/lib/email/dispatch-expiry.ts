import type { SupabaseClient } from '@supabase/supabase-js'
import { sendTemplate, type SendTemplateResult } from './service'
import { loadBookingEmailContext, type BookingEmailContext } from './context'

export const PAYMENT_EXPIRED_EVENT_TYPE = 'booking.payment_expired'

/** Shared by dispatchPaymentExpiredEmails() (the original, unconditional, immediate-dispatch path) and recoverMissingPaymentExpiredEmails() (P5D-EXPIRE-UNPAID-NOTIFICATION-RECOVERY-I's reconciliation pass) -- the exact same template/vars construction either way, so there is only one place that can drift from the other. */
async function sendPaymentExpiredEmailToRenter(admin: SupabaseClient, ctx: BookingEmailContext): Promise<SendTemplateResult> {
  return sendTemplate(admin, {
    eventType: PAYMENT_EXPIRED_EVENT_TYPE,
    templateId: 'booking-payment-expired-renter',
    recipientUserId: ctx.renterId,
    relatedEntityType: 'booking',
    relatedEntityId: ctx.bookingId,
    vars: { renterName: ctx.renterName, listingTitle: ctx.listingTitle, bookingReference: ctx.bookingReference },
  })
}

async function sendPaymentExpiredEmailToMerchant(admin: SupabaseClient, ctx: BookingEmailContext): Promise<SendTemplateResult> {
  return sendTemplate(admin, {
    eventType: PAYMENT_EXPIRED_EVENT_TYPE,
    templateId: 'booking-payment-expired-merchant',
    recipientUserId: ctx.merchantId,
    relatedEntityType: 'booking',
    relatedEntityId: ctx.bookingId,
    vars: { merchantName: ctx.merchantName, listingTitle: ctx.listingTitle, bookingReference: ctx.bookingReference },
  })
}

/**
 * Called by src/lib/bookings/lazy-expiry.ts right after
 * expire_unpaid_accepted_bookings() returns the ids it just transitioned
 * (Step 8 extended that RPC's return shape specifically to enable this --
 * see the migration). Sends the booking.payment_expired email to both
 * renter and merchant for each newly-expired booking, never for a booking
 * that was already expired before this sweep (the RPC only ever returns
 * ids it transitioned in that exact call, so a repeated sweep naturally
 * returns an empty list and this function is a no-op).
 *
 * Unconditional by design -- this is the normal, immediate-success path,
 * called exactly once per booking right after its own fresh transition.
 * It is intentionally unchanged by P5D-EXPIRE-UNPAID-NOTIFICATION-
 * RECOVERY-I: the recovery sweep is a separate, additive safety net (see
 * recoverMissingPaymentExpiredEmails below), not a replacement for this
 * synchronous dispatch.
 */
export async function dispatchPaymentExpiredEmails(admin: SupabaseClient, expiredBookingIds: string[]): Promise<void> {
  for (const bookingId of expiredBookingIds) {
    const ctx = await loadBookingEmailContext(admin, bookingId)
    if (!ctx) continue

    await sendPaymentExpiredEmailToRenter(admin, ctx)
    await sendPaymentExpiredEmailToMerchant(admin, ctx)
  }
}

const RECOVERY_BATCH_LIMIT = 100

export interface PaymentExpiredNotificationRecoveryResult {
  /**
   * P5D-EXPIRE-UNPAID-NOTIFICATION-RECOVERY-F1: rows returned by
   * find_missing_payment_expired_notifications() are already known-missing
   * by construction (a NOT EXISTS anti-join against email_deliveries,
   * evaluated in the database before any LIMIT) -- unlike the prior
   * "bookings inspected, not all missing" meaning, every candidate counted
   * here is a genuine (booking, recipient) task that had no delivery row
   * at all when the RPC ran.
   */
  candidatesScanned: number
  /** A genuinely new email_deliveries row was created for a recipient that had none at all (renter and/or merchant counted independently). */
  notificationsRecovered: number
  failed: number
}

/**
 * P5D-EXPIRE-UNPAID-NOTIFICATION-RECOVERY-I safety net: expire_unpaid_accepted_bookings()
 * commits the booking's status='expired' transition and
 * dispatchPaymentExpiredEmails() above sends the notification as a
 * SEPARATE, non-transactional step right after -- a crash/error between
 * those two means the booking is irreversibly 'expired' but the
 * notification was never even attempted, and because the RPC only ever
 * returns ids it JUST transitioned, no later sweep tick naturally retries
 * the dispatch for that booking again.
 *
 * Deliberately does NOT duplicate or compete with the email retry
 * subsystem (src/lib/email/service.ts's retryDelivery()/retryAllFailedDeliveries(),
 * already independently hardened and reviewed -- untouched here): this
 * function only ever considers a (booking, recipient) pair "missing" if
 * NO email_deliveries row exists for it at all. If any row already
 * exists -- 'pending', 'sent', 'failed_retryable', or 'failed_terminal'
 * -- that row's own lifecycle is authoritative and this function leaves
 * it alone entirely; recovering a true provider-send failure is the
 * retry subsystem's job, not this one's.
 *
 * P5D-EXPIRE-UNPAID-NOTIFICATION-RECOVERY-F1: the original implementation
 * selected "first 100 expired bookings within a 7-day lookback" and only
 * filtered out already-resolved recipients IN APPLICATION MEMORY after
 * that fetch. Because status='expired' and payment_expired_at never
 * change once set, an already-fully-resolved booking stayed eligible for
 * that same base query forever (until it aged out of the lookback), so
 * under sustained volume the same oldest resolved rows could occupy every
 * batch and starve a genuinely missing newer booking out of it entirely
 * -- and the 7-day cutoff could then permanently drop that missing
 * booking from consideration. This now delegates candidate selection to
 * find_missing_payment_expired_notifications() (see the migration), a
 * read-only RPC that evaluates the NOT EXISTS / unresolved predicate in
 * the database BEFORE any LIMIT, returning only genuinely missing
 * (booking, recipient) tasks with no age cutoff at all -- once a task's
 * delivery row is created, that exact tuple stops matching on the next
 * call, so the candidate set is self-draining under backlog without any
 * cursor/checkpoint state.
 *
 * Safety under concurrent/duplicate execution does NOT rest on this
 * function's own existence pre-check (which is a plain, racy
 * SELECT-then-decide, exactly like reconcile.ts's already-reviewed
 * candidate selection) -- it rests entirely on sendTemplate()'s own
 * pre-existing atomic claim: an INSERT guarded by the real
 * email_deliveries_idempotency_key_unique constraint, computed from
 * (event_type, booking_id, recipient_user_id, template_version), which
 * two concurrent recovery sweeps (or a recovery sweep racing the
 * original dispatch itself) cannot both win. A losing attempt returns
 * `skipped_duplicate` from sendTemplate() without ever reaching the
 * provider -- the exact same proven mechanism already relied on
 * throughout this codebase's email dispatch, unmodified by this phase.
 *
 * No age/race-avoidance delay is applied before a booking becomes
 * recovery-eligible: unlike a naive "read eligibility, then separately
 * act" race, the actual safety boundary here is the idempotency-key
 * constraint on the WRITE, not the timing of the READ, so running
 * recovery immediately after (or even nearly concurrently with) the
 * original dispatch is already safe.
 */
export async function recoverMissingPaymentExpiredEmails(admin: SupabaseClient): Promise<PaymentExpiredNotificationRecoveryResult> {
  let notificationsRecovered = 0
  let failed = 0

  const { data: candidates, error: candidatesError } = await admin.rpc('find_missing_payment_expired_notifications', {
    p_limit: RECOVERY_BATCH_LIMIT,
  })

  if (candidatesError || !candidates || candidates.length === 0) {
    return { candidatesScanned: 0, notificationsRecovered: 0, failed: candidatesError ? 1 : 0 }
  }

  const rows = candidates as Array<{ booking_id: string; recipient_role: 'renter' | 'merchant'; recipient_user_id: string }>

  // Two rows (renter + merchant) can share the same booking_id when
  // neither recipient has a delivery yet -- load each booking's context
  // at most once regardless of how many of its recipient tasks appear.
  const contextCache = new Map<string, BookingEmailContext | null>()
  async function getContext(bookingId: string): Promise<BookingEmailContext | null> {
    if (!contextCache.has(bookingId)) {
      contextCache.set(bookingId, await loadBookingEmailContext(admin, bookingId))
    }
    return contextCache.get(bookingId) ?? null
  }

  for (const row of rows) {
    try {
      const ctx = await getContext(row.booking_id)
      if (!ctx) continue

      // Any outcome other than skipped_duplicate means a genuinely new
      // email_deliveries row was created (sent/failed_retryable/
      // failed_terminal/skipped_no_recipient_email all insert a row --
      // only skipped_duplicate means the insert found this exact
      // idempotency key already claimed and created nothing).
      const result = row.recipient_role === 'renter'
        ? await sendPaymentExpiredEmailToRenter(admin, ctx)
        : await sendPaymentExpiredEmailToMerchant(admin, ctx)
      if (result.status !== 'skipped_duplicate') notificationsRecovered++
    } catch {
      failed++
    }
  }

  return { candidatesScanned: rows.length, notificationsRecovered, failed }
}
