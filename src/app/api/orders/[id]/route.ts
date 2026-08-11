import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * GET /api/orders/[id] -- full order detail for a party. Session client
 * throughout -- RLS ("orders: parties read") is the actual enforcement
 * boundary.
 *
 * buyer/seller identity is read from `public_profiles`, never a
 * `profiles!*_fkey(*)` embed -- that embed previously returned the
 * FULL profile row (phone, account_status, affiliate_code, etc.) for
 * BOTH parties, meaning either party could read their counterparty's
 * private fields simply by opening their own order. Fixed as part of
 * the Clickable Customer Profiles privacy-boundary corrective pass;
 * see supabase/migrations/20260831000001_profiles_privacy_boundary.sql.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { id: orderId } = await params
  if (!/^[0-9a-f-]{36}$/i.test(orderId)) {
    return NextResponse.json({ error: 'Invalid order id' }, { status: 400 })
  }

  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
  }

  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  if (!supabase) {
    return NextResponse.json({ error: 'Order storage is not configured' }, { status: 503 })
  }

  const { data: order, error: orderError } = await supabase
    .from('orders')
    .select('*, listing:listings(*, media:listing_media(*))')
    .eq('id', orderId)
    .maybeSingle()

  if (orderError) {
    console.error('[orders.detail] error', { userId: requester.userId, orderId, error: orderError })
    return NextResponse.json({ error: 'Could not load this order' }, { status: 500 })
  }
  if (!order) {
    // RLS makes a non-party's row indistinguishable from a nonexistent one.
    return NextResponse.json({ error: 'Order not found' }, { status: 404 })
  }

  const { data: parties } = await supabase
    .from('public_profiles')
    .select('id, display_name, full_name, avatar_url, role, is_verified, unity_score, created_at')
    .in('id', [order.buyer_id, order.seller_id])
  const partyById = new Map((parties ?? []).map((p) => [p.id, p]))
  const orderWithParties = { ...order, buyer: partyById.get(order.buyer_id), seller: partyById.get(order.seller_id) }

  const { data: history } = await supabase.from('order_history').select('*').eq('order_id', orderId).order('created_at', { ascending: true })
  const { data: payment } = await supabase.from('payments').select('status, failure_reason').eq('order_id', orderId).eq('payment_type', 'order_payment').maybeSingle()

  return NextResponse.json({ order: orderWithParties, history: history ?? [], payment: payment ?? null })
}
