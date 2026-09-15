import { NextRequest, NextResponse } from 'next/server'
import { hasCronAuthConfigured, isAuthorizedCronRequest } from '@/lib/internal-cron/auth'

/**
 * GET|POST /api/internal/expire-marketplace-requests -- Step Z.
 * Sweep (mirrors /api/internal/expire-unpaid-bookings exactly):
 * active/offers_received requests past their expires_at move to
 * date_passed. Never deletes. Bounded batch, safely re-runnable.
 * Scheduled via vercel.json (P4). GET (Vercel Cron) and POST
 * (manual/curl) share one handler and the shared
 * isAuthorizedCronRequest() authority (src/lib/internal-cron/auth.ts).
 */
async function handleCronRequest(request: NextRequest) {
  if (!hasCronAuthConfigured()) return NextResponse.json({ error: 'Internal expiry endpoint is not configured' }, { status: 503 })

  if (!isAuthorizedCronRequest(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return NextResponse.json({ error: 'Marketplace storage is not configured' }, { status: 503 })

  try {
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    const admin = createServiceClient(url, serviceKey)
    const { data, error } = await admin.rpc('expire_marketplace_requests', { p_limit: 200 })
    if (error) {
      console.error('[internal.expire-marketplace-requests] RPC error', error)
      return NextResponse.json({ error: 'Sweep failed' }, { status: 500 })
    }
    return NextResponse.json(data)
  } catch (err) {
    console.error('[internal.expire-marketplace-requests] unexpected error', { err })
    return NextResponse.json({ error: 'Sweep failed' }, { status: 500 })
  }
}

export async function GET(request: NextRequest) {
  return handleCronRequest(request)
}

export async function POST(request: NextRequest) {
  return handleCronRequest(request)
}
