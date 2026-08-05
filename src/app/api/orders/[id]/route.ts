import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * GET /api/orders/[id] -- full order detail for a party. Session client
 * throughout -- RLS ("orders: parties read") is the actual enforcement
 * boundary.
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
    .select('*, listing:listings(*, media:listing_media(*)), buyer:profiles!orders_buyer_id_fkey(*), seller:profiles!orders_seller_id_fkey(*)')
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

  const { data: history } = await supabase.from('order_history').select('*').eq('order_id', orderId).order('created_at', { ascending: true })
  const { data: payment } = await supabase.from('payments').select('status, failure_reason').eq('order_id', orderId).eq('payment_type', 'order_payment').maybeSingle()

  return NextResponse.json({ order, history: history ?? [], payment: payment ?? null })
}
