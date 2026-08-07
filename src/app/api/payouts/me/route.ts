import { NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'

/**
 * GET /api/payouts/me -- the caller's OWN payouts, scoped by
 * merchant_id = requester.userId at every query, never another
 * merchant's data. Read-only; merchants cannot mutate payout status.
 * Only failure_message_safe is ever returned for a failed payout --
 * never the admin's internal reason.
 */
export async function GET() {
  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Payout storage is not configured' }, { status: 503 })
  }

  const { createClient } = await import('@supabase/supabase-js')
  const admin = createClient(url, serviceKey)

  const { data: payouts, error } = await admin
    .from('merchant_payouts')
    .select('id, booking_id, amount, status, provider_reference, failure_message_safe, created_at, processing_started_at, paid_at, failed_at')
    .eq('merchant_id', requester.userId)
    .order('created_at', { ascending: false })

  if (error) {
    console.error('[payouts.me] error', { userId: requester.userId, error })
    return NextResponse.json({ error: 'Could not load your payouts' }, { status: 500 })
  }

  const bookingIds = (payouts ?? []).map((p) => p.booking_id).filter((id): id is string => !!id)
  const { data: bookings } = bookingIds.length
    ? await admin.from('bookings').select('id, booking_reference, listing_id').in('id', bookingIds)
    : { data: [] }

  const listingIds = Array.from(new Set((bookings ?? []).map((b) => b.listing_id)))
  const { data: listings } = listingIds.length ? await admin.from('listings').select('id, title').in('id', listingIds) : { data: [] }

  const bookingById = new Map((bookings ?? []).map((b) => [b.id, b]))
  const listingTitleById = new Map((listings ?? []).map((l) => [l.id, l.title]))

  const shaped = (payouts ?? []).map((p) => {
    const booking = p.booking_id ? bookingById.get(p.booking_id) : null
    return {
      id: p.id,
      amount: p.amount,
      currency: 'ZAR',
      status: p.status,
      payoutReference: p.provider_reference,
      failureMessage: p.failure_message_safe,
      bookingReference: booking?.booking_reference ?? null,
      listingTitle: booking ? (listingTitleById.get(booking.listing_id) ?? null) : null,
      createdAt: p.created_at,
      processingStartedAt: p.processing_started_at,
      paidAt: p.paid_at,
      failedAt: p.failed_at,
    }
  })

  const totals = {
    pending: shaped.filter((p) => p.status === 'pending').reduce((sum, p) => sum + Number(p.amount), 0),
    processing: shaped.filter((p) => p.status === 'processing').reduce((sum, p) => sum + Number(p.amount), 0),
    paid: shaped.filter((p) => p.status === 'paid').reduce((sum, p) => sum + Number(p.amount), 0),
    failed: shaped.filter((p) => p.status === 'failed').reduce((sum, p) => sum + Number(p.amount), 0),
  }

  return NextResponse.json({ payouts: shaped, totals })
}
