import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/internal/advertising/purge-events -- secret-authenticated
 * 90-day retention sweep for raw ad_impressions/ad_clicks ONLY (never
 * ad_balance_ledger/ad_campaign_history or any other immutable
 * financial/audit table -- see purge_expired_ad_events()'s own header
 * comment). No public route exists for this.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.INTERNAL_CRON_SECRET
  if (!secret) return NextResponse.json({ error: 'Internal advertising retention endpoint is not configured' }, { status: 503 })

  const provided = request.headers.get('authorization')
  if (provided !== `Bearer ${secret}`) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

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
