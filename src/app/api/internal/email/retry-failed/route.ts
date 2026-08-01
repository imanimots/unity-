import { NextRequest, NextResponse } from 'next/server'
import { retryAllFailedDeliveries } from '@/lib/email'

/**
 * POST /api/internal/email/retry-failed -- re-attempts every currently
 * failed_retryable delivery. Same secret-authenticated internal-route
 * pattern as the other two internal routes. Recommended cadence: every
 * 15-30 minutes, or triggered manually from the admin email-previews page
 * during development.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.INTERNAL_CRON_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'Internal retry endpoint is not configured' }, { status: 503 })
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
    const result = await retryAllFailedDeliveries(admin)
    return NextResponse.json({ considered_count: result.consideredCount, sent_count: result.sentCount, still_failing_count: result.stillFailingCount })
  } catch (err) {
    console.error('[internal.email.retry-failed] unexpected error', { err })
    return NextResponse.json({ error: 'Retry sweep failed' }, { status: 500 })
  }
}
