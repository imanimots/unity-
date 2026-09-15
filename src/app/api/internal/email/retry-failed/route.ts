import { NextRequest, NextResponse } from 'next/server'
import { retryAllFailedDeliveries } from '@/lib/email'
import { hasCronAuthConfigured, isAuthorizedCronRequest } from '@/lib/internal-cron/auth'

/**
 * GET|POST /api/internal/email/retry-failed -- re-attempts every
 * currently failed_retryable delivery. Scheduled via vercel.json (P4);
 * GET (Vercel Cron) and POST (manual/curl, or the admin email-previews
 * page during development) share one handler and the shared
 * isAuthorizedCronRequest() authority (src/lib/internal-cron/auth.ts).
 */
async function handleCronRequest(request: NextRequest) {
  if (!hasCronAuthConfigured()) {
    return NextResponse.json({ error: 'Internal retry endpoint is not configured' }, { status: 503 })
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
    const result = await retryAllFailedDeliveries(admin)
    return NextResponse.json({ considered_count: result.consideredCount, sent_count: result.sentCount, still_failing_count: result.stillFailingCount })
  } catch (err) {
    console.error('[internal.email.retry-failed] unexpected error', { err })
    return NextResponse.json({ error: 'Retry sweep failed' }, { status: 500 })
  }
}

export async function GET(request: NextRequest) {
  return handleCronRequest(request)
}

export async function POST(request: NextRequest) {
  return handleCronRequest(request)
}
