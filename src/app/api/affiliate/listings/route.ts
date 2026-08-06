import { NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'

/**
 * GET /api/affiliate/listings -- listings an affiliate may generate a
 * link for: exist, active, allow rental/sale (never barter-only -- no
 * such listing exists structurally, listing_type already gates this),
 * affiliates enabled. Caller must be a real affiliate.
 */
export async function GET() {
  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
  }
  if (!requester.profile.is_affiliate) {
    return NextResponse.json({ error: 'You are not an affiliate' }, { status: 403 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Affiliate storage is not configured' }, { status: 503 })
  }

  const { createClient } = await import('@supabase/supabase-js')
  const admin = createClient(url, serviceKey)

  const { data: listings, error } = await admin
    .from('listings')
    .select('id, title, listing_type, daily_rate, sale_price, affiliate_commission_rate, merchant_id, listing_media(url, display_order)')
    .eq('status', 'active')
    .eq('accepts_affiliates', true)
    .in('listing_type', ['rental', 'sale', 'both'])
    .order('created_at', { ascending: false })
    .limit(100)

  if (error) {
    console.error('[affiliate.listings] error', error)
    return NextResponse.json({ error: 'Could not load affiliate-enabled listings' }, { status: 500 })
  }

  const shaped = (listings ?? []).map((l) => {
    const media = (l.listing_media as unknown as { url: string; display_order: number }[] | null) ?? []
    const thumbnail = [...media].sort((a, b) => a.display_order - b.display_order)[0]?.url ?? null
    return {
      id: l.id,
      title: l.title,
      listing_type: l.listing_type,
      daily_rate: l.daily_rate,
      sale_price: l.sale_price,
      commission_rate: l.affiliate_commission_rate,
      thumbnail_url: thumbnail,
    }
  })

  return NextResponse.json({ listings: shaped })
}
