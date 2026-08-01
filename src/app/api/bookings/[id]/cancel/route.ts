import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { cancelBookingSchema } from '@/lib/bookings/validation'
import { mapBookingRpcError } from '@/lib/bookings/rpc-errors'
import { computeCancelBookingHash, checkIdempotentReplay } from '@/lib/bookings/idempotency'
import { sendTemplate, loadBookingEmailContext } from '@/lib/email'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/bookings/[id]/cancel -- renter or merchant cancellation.
 * cancel_booking() derives which side the caller is on from the booking
 * row itself (renter_id/merchant_id match), not from a client-supplied
 * role -- see the RPC's own comment in 20260730000007_booking_rpcs.sql.
 * Either role may hit this same route; the RPC enforces which
 * transitions are allowed for each.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: bookingId } = await params
  if (!/^[0-9a-f-]{36}$/i.test(bookingId)) {
    return NextResponse.json({ error: 'Invalid booking id' }, { status: 400 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Booking storage is not configured' }, { status: 503 })
  }

  const rate = checkRateLimit(`bookings:cancel:${getClientKey(request)}`, 20, 60_000)
  if (!rate.allowed) {
    return NextResponse.json({ error: 'Too many requests — please slow down' }, { status: 429 })
  }

  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    body = {}
  }
  const parsed = cancelBookingSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  try {
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    const admin = createServiceClient(url, serviceKey)

    if (parsed.data.idempotency_key) {
      const hash = computeCancelBookingHash(bookingId, parsed.data.cancellation_reason)
      const replay = await checkIdempotentReplay(admin, requester.userId, 'cancel_booking', parsed.data.idempotency_key, hash)
      if (replay.status === 'replay') return NextResponse.json(replay.result)
      if (replay.status === 'conflict') {
        const mapped = mapBookingRpcError('idempotency key already used with a different request')
        return NextResponse.json({ error: mapped.error }, { status: mapped.status })
      }
    }

    const { data, error } = await admin.rpc('cancel_booking', {
      p_actor_user_id: requester.userId,
      p_booking_id: bookingId,
      p_cancellation_reason: parsed.data.cancellation_reason ?? null,
      p_idempotency_key: parsed.data.idempotency_key ?? null,
    })

    if (error) {
      console.error('[bookings.cancel] RPC error', { userId: requester.userId, bookingId, error })
      const mapped = mapBookingRpcError(error.message)
      return NextResponse.json({ error: mapped.error }, { status: mapped.status })
    }

    try {
      const ctx = await loadBookingEmailContext(admin, bookingId)
      if (ctx) {
        await sendTemplate(admin, {
          eventType: 'booking.cancelled',
          templateId: 'booking-cancelled-renter',
          recipientUserId: ctx.renterId,
          relatedEntityType: 'booking',
          relatedEntityId: ctx.bookingId,
          vars: { renterName: ctx.renterName, listingTitle: ctx.listingTitle, bookingReference: ctx.bookingReference },
        })
        await sendTemplate(admin, {
          eventType: 'booking.cancelled',
          templateId: 'booking-cancelled-merchant',
          recipientUserId: ctx.merchantId,
          relatedEntityType: 'booking',
          relatedEntityId: ctx.bookingId,
          vars: { merchantName: ctx.merchantName, listingTitle: ctx.listingTitle, bookingReference: ctx.bookingReference },
        })
      }
    } catch (emailErr) {
      console.error('[bookings.cancel] email dispatch failed', { bookingId, emailErr })
    }

    return NextResponse.json(data)
  } catch (err) {
    console.error('[bookings.cancel] unexpected error', { userId: requester.userId, bookingId, err })
    return NextResponse.json({ error: 'Could not cancel this booking — please try again' }, { status: 500 })
  }
}
