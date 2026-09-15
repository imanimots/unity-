import { NextRequest, NextResponse } from 'next/server'
import { hasCronAuthConfigured, isAuthorizedCronRequest } from '@/lib/internal-cron/auth'

/**
 * GET|POST /api/internal/advertising/purge-events -- 90-day retention
 * sweep for raw ad_impressions/ad_clicks ONLY (never ad_balance_ledger/
 * ad_campaign_history or any other immutable financial/audit table --
 * see purge_expired_ad_events()'s own header comment). No public route
 * exists for this. Scheduled via vercel.json (P4), off-peak daily. GET
 * (Vercel Cron) and POST (manual/curl) share one handler and the shared
 * isAuthorizedCronRequest() authority (src/lib/internal-cron/auth.ts).
 */
async function handleCronRequest(request: NextRequest) {
  if (!hasCronAuthConfigured()) return NextResponse.json({ error: 'Internal advertising retention endpoint is not configured' }, { status: 503 })

  if (!isAuthorizedCronRequest(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return NextResponse.json({ error: 'Advertising storage is not configured' }, { status: 503 })

  try {
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    const admin = createServiceClient(url, serviceKey)
    const { data, error } = await admin.rpc('purge_expired_ad_events')
    if (error) {
      console.error('[internal.advertising.purge-events] RPC error', error)
      return NextResponse.json({ error: 'Purge failed' }, { status: 500 })
    }
    return NextResponse.json(data)
  } catch (err) {
    console.error('[internal.advertising.purge-events] unexpected error', { err })
    return NextResponse.json({ error: 'Purge failed' }, { status: 500 })
  }
}

export async function GET(request: NextRequest) {
  return handleCronRequest(request)
}

export async function POST(request: NextRequest) {
  return handleCronRequest(request)
}
