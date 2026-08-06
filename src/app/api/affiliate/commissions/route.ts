import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'

/** GET /api/affiliate/commissions -- the caller's own commissions only (RLS-backed, service-role query still scoped explicitly). */
export async function GET(request: NextRequest) {
  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Affiliate storage is not configured' }, { status: 503 })
  }

  const { createClient } = await import('@supabase/supabase-js')
  const admin = createClient(url, serviceKey)

  const statusParam = request.nextUrl.searchParams.get('status')

  let query = admin
    .from('affiliate_commissions')
    .select('id, transaction_type, listing_id, order_id, booking_id, commission_amount, currency, status, created_at, approved_at, payout_confirmed_at, listings(title)')
    .eq('affiliate_id', requester.userId)
    .order('created_at', { ascending: false })
    .limit(200)

  if (statusParam && statusParam !== 'all') {
    query = query.eq('status', statusParam)
  }

  const { data, error } = await query
  if (error) {
    console.error('[affiliate.commissions] error', { userId: requester.userId, error })
    return NextResponse.json({ error: 'Could not load your commissions' }, { status: 500 })
  }

  const commissions = (data ?? []).map((c) => ({
    id: c.id,
    transactionType: c.transaction_type,
    listingId: c.listing_id,
    listingTitle: (c.listings as unknown as { title: string } | null)?.title ?? null,
    reference: c.order_id ?? c.booking_id,
    commissionAmount: c.commission_amount,
    currency: c.currency,
    status: c.status,
    createdAt: c.created_at,
    approvedAt: c.approved_at,
    paidAt: c.payout_confirmed_at,
  }))

  return NextResponse.json({ commissions })
}
