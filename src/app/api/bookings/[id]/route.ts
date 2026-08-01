import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { triggerLazyExpirySweep } from '@/lib/bookings/lazy-expiry'

interface RouteParams {
  params: Promise<{ id: string }>
}

/** GET /api/bookings/[id] -- fetch one booking, plus its history, if the caller is a party to it. */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  const { id: bookingId } = await params
  if (!/^[0-9a-f-]{36}$/i.test(bookingId)) {
    return NextResponse.json({ error: 'Invalid booking id' }, { status: 400 })
  }

  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
  }

  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  if (!supabase) {
    return NextResponse.json({ error: 'Booking storage is not configured' }, { status: 503 })
  }

  // expire_unpaid_accepted_bookings() is service-role only -- the session
  // client above can't call it, so a narrow service-role client is
  // constructed just for this trigger. Never throws into the response;
  // see triggerLazyExpirySweep's own comment.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (url && serviceKey) {
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    await triggerLazyExpirySweep(createServiceClient(url, serviceKey))
  }

  // RLS ("bookings: parties read") scopes this to the caller's own booking.
  const { data: booking, error } = await supabase.from('bookings').select('*').eq('id', bookingId).maybeSingle()
  if (error || !booking) {
    return NextResponse.json({ error: 'Booking not found' }, { status: 404 })
  }

  const { data: history } = await supabase
    .from('booking_history')
    .select('id, actor_role, event_type, previous_status, new_status, metadata, created_at')
    .eq('booking_id', bookingId)
    .order('created_at', { ascending: true })

  return NextResponse.json({ booking, history: history ?? [] })
}
