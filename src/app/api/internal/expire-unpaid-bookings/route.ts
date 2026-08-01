import { NextRequest, NextResponse } from 'next/server'
import { triggerLazyExpirySweep } from '@/lib/bookings/lazy-expiry'

/**
 * POST /api/internal/expire-unpaid-bookings -- the one safe entry point
 * for a future scheduler (Vercel Cron or equivalent) to invoke the
 * expire_unpaid_accepted_bookings() sweep on a fixed cadence, rather than
 * relying solely on the lazy-expiry trigger fired from user-facing reads
 * (src/lib/bookings/lazy-expiry.ts). Recommended cadence: every 5-15
 * minutes -- frequent enough that an unpaid booking's dates free up
 * promptly, infrequent enough to be cheap at MVP scale.
 *
 * Secret-authenticated, not session-authenticated -- this is a
 * machine-to-machine route with no concept of a signed-in user. Requires
 * INTERNAL_CRON_SECRET to be set; if it is not configured, the route
 * refuses to run rather than defaulting open. Never call this from any
 * client-side code -- the secret must never reach the browser (it is not
 * a NEXT_PUBLIC_ variable).
 *
 * No scheduler is actually configured this phase (see Step 6's "Scheduler
 * preparation" -- production cron wiring is explicitly out of scope);
 * this route exists so wiring one later requires no new code, only a
 * cron configuration pointing at this URL with the secret header.
 *
 * Step 8: now delegates to triggerLazyExpirySweep() (src/lib/bookings/
 * lazy-expiry.ts) instead of calling the RPC directly, so a
 * scheduler-driven sweep dispatches booking.payment_expired emails
 * exactly the same way a lazy, read-triggered sweep does -- one sweep
 * implementation, not two.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.INTERNAL_CRON_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'Internal expiry endpoint is not configured' }, { status: 503 })
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
    const result = await triggerLazyExpirySweep(admin)
    if (!result) {
      return NextResponse.json({ error: 'Sweep failed' }, { status: 500 })
    }
    return NextResponse.json({ expired_count: result.expiredCount, skipped_ready_count: result.skippedReadyCount })
  } catch (err) {
    console.error('[internal.expire-unpaid-bookings] unexpected error', { err })
    return NextResponse.json({ error: 'Sweep failed' }, { status: 500 })
  }
}
