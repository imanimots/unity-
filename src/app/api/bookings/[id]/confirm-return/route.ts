import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { bookingActionSchema } from '@/lib/bookings/validation'
import { mapBookingRpcError } from '@/lib/bookings/rpc-errors'
import { computeBookingIdOnlyHash, checkIdempotentReplay } from '@/lib/bookings/idempotency'
import { sendTemplate, loadBookingEmailContext } from '@/lib/email'
import { createMerchantPayout } from '@/lib/payments/orchestrator'
import { notifyMerchantPayoutEvent } from '@/lib/payouts/notify'
import { releaseEscrowForPayment } from '@/lib/escrow/orchestrator'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/bookings/[id]/confirm-return -- the counterparty confirms
 * return, moving return_pending -> returned -> completed in one RPC call.
 * confirm_return() rejects the party who initiated the return trying to
 * confirm their own initiation.
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

  const rate = checkRateLimit(`bookings:confirm-return:${getClientKey(request)}`, 20, 60_000)
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
      const replay = await checkIdempotentReplay(admin, requester.userId, 'confirm_return', parsed.data.idempotency_key, hash)
      if (replay.status === 'replay') return NextResponse.json(replay.result)
      if (replay.status === 'conflict') {
        const mapped = mapBookingRpcError('idempotency key already used with a different request')
        return NextResponse.json({ error: mapped.error }, { status: mapped.status })
      }
    }

    const { data, error } = await admin.rpc('confirm_return', {
      p_actor_user_id: requester.userId,
      p_booking_id: bookingId,
      p_idempotency_key: parsed.data.idempotency_key ?? null,
    })

    if (error) {
      console.error('[bookings.confirm-return] RPC error', { userId: requester.userId, bookingId, error })
      const mapped = mapBookingRpcError(error.message)
      return NextResponse.json({ error: mapped.error }, { status: mapped.status })
    }

    // confirm_return() moves return_pending -> returned -> completed in
    // one call -- one consolidated "completed" email covers both
    // transitions rather than sending a separate "return confirmed" email
    // that would just be superseded a moment later. See
    // docs/TRANSACTIONAL_EMAILS.md "Event-to-template matrix".
    try {
      const ctx = await loadBookingEmailContext(admin, bookingId)
      if (ctx) {
        await sendTemplate(admin, {
          eventType: 'booking.completed',
          templateId: 'booking-completed-renter',
          recipientUserId: ctx.renterId,
          relatedEntityType: 'booking',
          relatedEntityId: ctx.bookingId,
          vars: { renterName: ctx.renterName, listingTitle: ctx.listingTitle, bookingReference: ctx.bookingReference },
        })
        await sendTemplate(admin, {
          eventType: 'booking.completed',
          templateId: 'booking-completed-merchant',
          recipientUserId: ctx.merchantId,
          relatedEntityType: 'booking',
          relatedEntityId: ctx.bookingId,
          vars: { merchantName: ctx.merchantName, listingTitle: ctx.listingTitle, bookingReference: ctx.bookingReference },
        })
      }
    } catch (emailErr) {
      console.error('[bookings.confirm-return] email dispatch failed', { bookingId, emailErr })
    }

    // Step 11 Phase 8: best-effort payout-obligation creation, never
    // blocking the return confirmation itself. Creates only a 'pending'
    // row -- no provider is called here (see create-merchant-payout.ts's
    // own header comment). A transient failure here is recovered by the
    // reconcile-missing internal sweep, not by the merchant retrying
    // this route.
    try {
      const payoutIdempotencyKey = parsed.data.idempotency_key ? `${parsed.data.idempotency_key}-payout` : undefined
      const payout = await createMerchantPayout({ admin }, bookingId, payoutIdempotencyKey)
      try {
        await notifyMerchantPayoutEvent(admin, payout.payoutId, 'merchant_payout.created')
      } catch (emailErr) {
        console.error('[bookings.confirm-return] payout-created email dispatch failed', { bookingId, payoutId: payout.payoutId, emailErr })
      }
    } catch (payoutErr) {
      console.error('[bookings.confirm-return] payout creation failed', { bookingId, payoutErr })
    }

    // Phase 3: best-effort escrow release at the booking's own completion
    // point, never blocking return confirmation. A no-op unless
    // ESCROW_ENABLED and an escrow transaction actually exists.
    try {
      const { data: booking } = await admin.from('bookings').select('merchant_id').eq('id', bookingId).maybeSingle()
      const { data: rentalPayment } = await admin.from('payments').select('id').eq('booking_id', bookingId).eq('payment_type', 'rental_charge').maybeSingle()
      if (booking && rentalPayment) {
        await releaseEscrowForPayment(admin, rentalPayment.id, booking.merchant_id, { actorType: 'system', reason: 'booking completed' })
      }
    } catch (escrowErr) {
      console.error('[bookings.confirm-return] escrow release failed', { bookingId, escrowErr })
    }

    return NextResponse.json(data)
  } catch (err) {
    console.error('[bookings.confirm-return] unexpected error', { userId: requester.userId, bookingId, err })
    return NextResponse.json({ error: 'Could not confirm the return — please try again' }, { status: 500 })
  }
}
