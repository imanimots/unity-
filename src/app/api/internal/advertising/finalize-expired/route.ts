import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/internal/advertising/finalize-expired -- secret-authenticated
 * sweep (mirrors /api/internal/expire-marketplace-requests exactly):
 * active/paused campaigns past their end_at transition to completed,
 * crediting any undelivered quota value to the advertiser's
 * non-withdrawable Advertising Balance (the binding underdelivery-
 * credit formula). Never touches quota-reached completions (handled
 * atomically inside record_ad_impression) or voluntary cancellations
 * (handled inside cancel_ad_campaign, no underdelivery credit).
 */
export async function POST(request: NextRequest) {
  const secret = process.env.INTERNAL_CRON_SECRET
  if (!secret) return NextResponse.json({ error: 'Internal advertising sweep endpoint is not configured' }, { status: 503 })

  const provided = request.headers.get('authorization')
  if (provided !== `Bearer ${secret}`) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return NextResponse.json({ error: 'Advertising storage is not configured' }, { status: 503 })

  try {
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    const admin = createServiceClient(url, serviceKey)
    const { data, error } = await admin.rpc('finalize_expired_ad_campaigns', { p_actor_id: null })
    if (error) {
      console.error('[internal.advertising.finalize-expired] RPC error', error)
      return NextResponse.json({ error: 'Sweep failed' }, { status: 500 })
    }
    return NextResponse.json(data)
  } catch (err) {
    console.error('[internal.advertising.finalize-expired] unexpected error', { err })
    return NextResponse.json({ error: 'Sweep failed' }, { status: 500 })
  }
}
