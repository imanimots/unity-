import { NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { getAdminServiceClient } from '@/lib/admin/route-helpers'

/**
 * GET /api/advertising/merchant-listings -- the caller's OWN active,
 * non-test listings, minimally shaped for the "select a target" step of
 * campaign creation. Scoped by merchant_id = requester.userId only.
 */
export async function GET() {
  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
  }

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Advertising storage is not configured' }, { status: 503 })
  }

  const { data, error } = await admin
    .from('listings')
    .select('id, title, category, daily_rate, status')
    .eq('merchant_id', requester.userId)
    .eq('status', 'active')
    .eq('is_test', false)
    .order('created_at', { ascending: false })

  if (error) {
    return NextResponse.json({ error: 'Could not load your listings' }, { status: 500 })
  }

  return NextResponse.json({ listings: data ?? [] })
}
