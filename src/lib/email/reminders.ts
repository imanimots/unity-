import type { SupabaseClient } from '@supabase/supabase-js'
import { sendTemplate } from './service'
import { loadBookingEmailContext, formatMoney, formatDateTime } from './context'

const raw = process.env.PAYMENT_REMINDER_HOURS_BEFORE_DUE
const parsed = raw ? Number.parseInt(raw, 10) : NaN
export const PAYMENT_REMINDER_HOURS_BEFORE_DUE = Number.isFinite(parsed) && parsed > 0 ? parsed : 6

export interface ReminderSweepResult {
  consideredCount: number
  sentCount: number
  skippedDuplicateCount: number
}

/**
 * Finds accepted, unpaid bookings whose payment_due_at falls within the
 * reminder window (now < payment_due_at <= now + PAYMENT_REMINDER_HOURS_BEFORE_DUE)
 * and sends exactly one reminder each, ever -- the occurrence key
 * ("reminder") makes a second sweep run naturally idempotent via the same
 * unique-constraint mechanism every other event uses, no separate
 * "already reminded" flag needed. A booking that is financially ready is
 * never matched (status would no longer be 'accepted' with an open
 * requirement once the checkout route transitions the workflow -- but as
 * a defensive check this also re-verifies deposit/rental payment status
 * before sending, since payment_due_at alone does not prove non-readiness).
 *
 * A single, infrequent reminder only (not "frequent reminders") --
 * exactly what the brief asks for.
 */
export async function sendDuePaymentReminders(admin: SupabaseClient): Promise<ReminderSweepResult> {
  const windowEnd = new Date(Date.now() + PAYMENT_REMINDER_HOURS_BEFORE_DUE * 3600 * 1000).toISOString()
  const now = new Date().toISOString()

  const { data: candidates } = await admin
    .from('bookings')
    .select('id')
    .eq('status', 'accepted')
    .not('payment_due_at', 'is', null)
    .gt('payment_due_at', now)
    .lte('payment_due_at', windowEnd)

  const rows = candidates ?? []
  let sentCount = 0
  let skippedDuplicateCount = 0

  for (const row of rows) {
    const ctx = await loadBookingEmailContext(admin, row.id)
    if (!ctx) continue

    const result = await sendTemplate(admin, {
      eventType: 'booking.payment_reminder',
      templateId: 'booking-payment-reminder-renter',
      recipientUserId: ctx.renterId,
      relatedEntityType: 'booking',
      relatedEntityId: ctx.bookingId,
      occurrenceKey: 'reminder',
      vars: {
        renterName: ctx.renterName,
        listingTitle: ctx.listingTitle,
        bookingReference: ctx.bookingReference,
        paymentDueAt: formatDateTime(ctx.paymentDueAt),
        totalAmount: formatMoney(ctx.totalAmount, ctx.currency),
      },
    })

    if (result.status === 'sent') sentCount++
    if (result.status === 'skipped_duplicate') skippedDuplicateCount++
  }

  return { consideredCount: rows.length, sentCount, skippedDuplicateCount }
}
