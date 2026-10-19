import { NextRequest, NextResponse } from 'next/server'
import { triggerLazyExpirySweep } from '@/lib/bookings/lazy-expiry'
import { recoverMissingPaymentExpiredEmails } from '@/lib/email/dispatch-expiry'
import { hasCronAuthConfigured, isAuthorizedCronRequest, isAuthorizedGcpSchedulerRequest } from '@/lib/internal-cron/auth'

/**
 * GET|POST /api/internal/expire-unpaid-bookings -- invokes the
 * expire_unpaid_accepted_bookings() sweep on a fixed cadence (via
 * triggerLazyExpirySweep(), src/lib/bookings/lazy-expiry.ts), rather than
 * relying solely on the lazy-expiry trigger fired from user-facing reads.
 * Scheduled hourly via vercel.json (P4) -- recommended cadence stays
 * every 5-15 minutes for a tighter future schedule if warranted; frequent
 * enough that an unpaid booking's dates free up promptly, infrequent
 * enough to be cheap at MVP scale.
 *
 * Secret-authenticated, not session-authenticated -- this is a
 * machine-to-machine route with no concept of a signed-in user. GET
 * (Vercel Cron's own invocation method) and POST (this codebase's
 * pre-existing manual/curl convention) both delegate to the same
 * handler and the same isAuthorizedCronRequest() authority
 * (src/lib/internal-cron/auth.ts) -- no business-logic drift between
 * the two entry points. Refuses to run rather than defaulting open if
 * neither secret is configured. Never call this from any client-side
 * code -- no secret ever reaches the browser (neither is a
 * NEXT_PUBLIC_ variable).
 *
 * Step 8: delegates to triggerLazyExpirySweep() (src/lib/bookings/
 * lazy-expiry.ts) instead of calling the RPC directly, so a
 * scheduler-driven sweep dispatches booking.payment_expired emails
 * exactly the same way a lazy, read-triggered sweep does -- one sweep
 * implementation, not two.
 */
async function handleCronRequest(request: NextRequest) {
  if (!hasCronAuthConfigured()) {
    return NextResponse.json({ error: 'Internal expiry endpoint is not configured' }, { status: 503 })
  }
  if (!isAuthorizedCronRequest(request) && !(await isAuthorizedGcpSchedulerRequest(request))) {
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
    const result = await triggerLazyExpirySweep(admin)
    if (!result) {
      return NextResponse.json({ error: 'Sweep failed' }, { status: 500 })
    }

    // P5D-EXPIRE-UNPAID-NOTIFICATION-RECOVERY-I: a second, additive pass
    // that only this scheduled route runs (never the shared lazy-expiry
    // trigger used by user-facing read/write paths) -- recovers a
    // payment_expired notification that a prior tick's crash left
    // genuinely missing. Never competes with the email retry subsystem;
    // see recoverMissingPaymentExpiredEmails()'s own doc comment.
    let notificationsRecovered = 0
    try {
      const recovery = await recoverMissingPaymentExpiredEmails(admin)
      notificationsRecovered = recovery.notificationsRecovered
    } catch (recoveryErr) {
      console.error('[internal.expire-unpaid-bookings] notification recovery failed', { recoveryErr })
    }

    return NextResponse.json({
      expired_count: result.expiredCount,
      skipped_ready_count: result.skippedReadyCount,
      notifications_recovered: notificationsRecovered,
    })
  } catch (err) {
    console.error('[internal.expire-unpaid-bookings] unexpected error', { err })
    return NextResponse.json({ error: 'Sweep failed' }, { status: 500 })
  }
}

export async function GET(request: NextRequest) {
  return handleCronRequest(request)
}

export async function POST(request: NextRequest) {
  return handleCronRequest(request)
}
