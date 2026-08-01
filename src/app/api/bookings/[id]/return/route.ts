import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { bookingActionSchema } from '@/lib/bookings/validation'
import { mapBookingRpcError } from '@/lib/bookings/rpc-errors'
import { computeBookingIdOnlyHash, checkIdempotentReplay } from '@/lib/bookings/idempotency'
import { sendTemplate, loadBookingEmailContext } from '@/lib/email'

interface RouteParams {
  params: Promise<{ id: string }>
}

/** POST /api/bookings/[id]/return -- either party initiates the return of an active booking. */
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

  const rate = checkRateLimit(`bookings:return:${getClientKey(request)}`, 20, 60_000)
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
  const parsed = bookingActionSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  try {
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    const admin = createServiceClient(url, serviceKey)

    if (parsed.data.idempotency_key) {
      const hash = computeBookingIdOnlyHash(bookingId)
      const replay = await checkIdempotentReplay(admin, requester.userId, 'initiate_return', parsed.data.idempotency_key, hash)
      if (replay.status === 'replay') return NextResponse.json(replay.result)
      if (replay.status === 'conflict') {
        const mapped = mapBookingRpcError('idempotency key already used with a different request')
        return NextResponse.json({ error: mapped.error }, { status: mapped.status })
      }
    }

    const { data, error } = await admin.rpc('initiate_return', {
      p_actor_user_id: requester.userId,
      p_booking_id: bookingId,
      p_idempotency_key: parsed.data.idempotency_key ?? null,
    })

    if (error) {
      console.error('[bookings.return] RPC error', { userId: requester.userId, bookingId, error })
      const mapped = mapBookingRpcError(error.message)
      return NextResponse.json({ error: mapped.error }, { status: mapped.status })
    }

    try {
      const ctx = await loadBookingEmailContext(admin, bookingId)
      if (ctx) {
        const otherPartyIsRenter = requester.userId === ctx.merchantId
        await sendTemplate(admin, {
          eventType: 'booking.return_initiated',
          templateId: 'booking-return-initiated-notify',
          recipientUserId: otherPartyIsRenter ? ctx.renterId : ctx.merchantId,
          relatedEntityType: 'booking',
          relatedEntityId: ctx.bookingId,
          vars: {
            recipientName: otherPartyIsRenter ? ctx.renterName : ctx.merchantName,
            listingTitle: ctx.listingTitle,
            bookingReference: ctx.bookingReference,
          },
        })
      }
    } catch (emailErr) {
      console.error('[bookings.return] email dispatch failed', { bookingId, emailErr })
    }

    return NextResponse.json(data)
  } catch (err) {
    console.error('[bookings.return] unexpected error', { userId: requester.userId, bookingId, err })
    return NextResponse.json({ error: 'Could not initiate the return — please try again' }, { status: 500 })
  }
}
