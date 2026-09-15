import { NextRequest, NextResponse } from 'next/server'
import { sendDuePaymentReminders } from '@/lib/email'
import { hasCronAuthConfigured, isAuthorizedCronRequest } from '@/lib/internal-cron/auth'

/**
 * GET|POST /api/internal/email/send-payment-reminders -- the
 * payment-deadline reminder sweep. Scheduled via vercel.json (P4);
 * GET (Vercel Cron) and POST (manual/curl) share one handler and the
 * shared isAuthorizedCronRequest() authority (src/lib/internal-cron/
 * auth.ts). Reminders are a single, infrequent nudge
 * (PAYMENT_REMINDER_HOURS_BEFORE_DUE), not something that needs
 * minute-level precision.
 */
async function handleCronRequest(request: NextRequest) {
  if (!hasCronAuthConfigured()) {
    return NextResponse.json({ error: 'Internal reminder endpoint is not configured' }, { status: 503 })
  }
  if (!isAuthorizedCronRequest(request)) {
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

export async function GET(request: NextRequest) {
  return handleCronRequest(request)
}

export async function POST(request: NextRequest) {
  return handleCronRequest(request)
}
