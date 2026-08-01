import { NextRequest, NextResponse } from 'next/server'
import { sendDuePaymentReminders } from '@/lib/email'

/**
 * POST /api/internal/email/send-payment-reminders -- the payment-deadline
 * reminder sweep, on the same secret-authenticated internal-route pattern
 * as Step 6's POST /api/internal/expire-unpaid-bookings. Recommended
 * cadence: every 15-30 minutes -- reminders are a single, infrequent nudge
 * (PAYMENT_REMINDER_HOURS_BEFORE_DUE), not something that needs
 * minute-level precision.
 *
 * No scheduler is actually configured this phase -- this route exists so
 * wiring one later needs no new code, only a cron configuration pointing
 * at this URL with the secret header.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.INTERNAL_CRON_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'Internal reminder endpoint is not configured' }, { status: 503 })
  }

  const provided = request.headers.get('authorization')
  if (provided !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Booking storage is not configured' }, { status: 503 })
  }

  try {
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    const admin = createServiceClient(url, serviceKey)
    const result = await sendDuePaymentReminders(admin)
    return NextResponse.json({ considered_count: result.consideredCount, sent_count: result.sentCount, skipped_duplicate_count: result.skippedDuplicateCount })
  } catch (err) {
    console.error('[internal.email.send-payment-reminders] unexpected error', { err })
    return NextResponse.json({ error: 'Reminder sweep failed' }, { status: 500 })
  }
}
