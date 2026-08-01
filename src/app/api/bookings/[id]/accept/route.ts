import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { acceptBookingSchema } from '@/lib/bookings/validation'
import { mapBookingRpcError } from '@/lib/bookings/rpc-errors'
import { computeAcceptBookingRequestHash, checkIdempotentReplay } from '@/lib/bookings/idempotency'
import { BOOKING_PAYMENT_DEADLINE_HOURS } from '@/lib/bookings/payment-deadline'
import { sendTemplate, loadBookingEmailContext, formatMoney, formatDateTime } from '@/lib/email'
import { blockIfCannotTransact } from '@/lib/admin/account-status'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/bookings/[id]/accept -- merchant accepts a requested booking.
 * accept_booking_request() is service-role only -- ownership, requested
 * status, expiry, and the race-safe conflict check (a Postgres exclusion
 * constraint, not an application-level check-then-write) all live in the
 * RPC. p_merchant_id is always requester.userId, never client-supplied.
 *
 * Consistency model: booking acceptance and financial authorization are
 * two deliberately separate steps (as of Step 5 -- see
 * docs/MOCK_CHECKOUT.md "Why checkout is renter-triggered"). Acceptance
 * only marks the booking ready for the renter to pay; it no longer calls
 * the Financial Orchestrator itself. This route previously invoked
 * authorizeBookingFinancials() automatically right after acceptance,
 * which silently completed the mock rental charge + deposit authorization
 * before the renter had any involvement -- incompatible with Step 5's
 * required journey (renter selects a scenario, then authorization runs).
 * Financial authorization now happens exclusively via
 * POST /api/bookings/[id]/checkout, driven by the renter.
 *
 * Step 6: acceptance also derives and stores payment_due_at (server-side,
 * via accept_booking_request's p_payment_deadline_hours parameter --
 * BOOKING_PAYMENT_DEADLINE_HOURS is the single source for the duration,
 * see src/lib/bookings/payment-deadline.ts). See docs/PAYMENT_READINESS.md.
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

  const rate = checkRateLimit(`bookings:accept:${getClientKey(request)}`, 20, 60_000)
  if (!rate.allowed) {
    return NextResponse.json({ error: 'Too many requests — please slow down' }, { status: 429 })
  }

  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
  }
  if (requester.profile.role !== 'merchant' && requester.profile.role !== 'both') {
    return NextResponse.json({ error: 'Only merchant accounts can accept bookings' }, { status: 403 })
  }
  const blocked = blockIfCannotTransact(requester.profile)
  if (blocked) return blocked

  let body: unknown
  try {
    body = await request.json()
  } catch {
    body = {}
  }
  const parsed = acceptBookingSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  try {
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    const admin = createServiceClient(url, serviceKey)

    if (parsed.data.idempotency_key) {
      const hash = computeAcceptBookingRequestHash(bookingId, parsed.data.merchant_response_note)
      const replay = await checkIdempotentReplay(admin, requester.userId, 'accept_booking_request', parsed.data.idempotency_key, hash)
      if (replay.status === 'replay') {
        return NextResponse.json(replay.result as Record<string, unknown>)
      }
      if (replay.status === 'conflict') {
        const mapped = mapBookingRpcError('idempotency key already used with a different request')
        return NextResponse.json({ error: mapped.error }, { status: mapped.status })
      }
    }

    const { data, error } = await admin.rpc('accept_booking_request', {
      p_merchant_id: requester.userId,
      p_booking_id: bookingId,
      p_merchant_response_note: parsed.data.merchant_response_note ?? null,
      p_idempotency_key: parsed.data.idempotency_key ?? null,
      p_payment_deadline_hours: BOOKING_PAYMENT_DEADLINE_HOURS,
    })

    if (error) {
      console.error('[bookings.accept] RPC error', { userId: requester.userId, bookingId, error })
      const mapped = mapBookingRpcError(error.message)
      return NextResponse.json({ error: mapped.error }, { status: mapped.status })
    }

    // Consolidated: one "payment required" email covers both "your
    // booking was accepted" and "here's the deadline" -- a separate
    // booking.accepted email would just be a subset of this one. See
    // docs/TRANSACTIONAL_EMAILS.md "Event-to-template matrix".
    try {
      const ctx = await loadBookingEmailContext(admin, bookingId)
      if (ctx) {
        await sendTemplate(admin, {
          eventType: 'booking.payment_required',
          templateId: 'booking-payment-required-renter',
          recipientUserId: ctx.renterId,
          relatedEntityType: 'booking',
          relatedEntityId: ctx.bookingId,
          vars: {
            renterName: ctx.renterName,
            listingTitle: ctx.listingTitle,
            bookingReference: ctx.bookingReference,
            paymentDueAt: formatDateTime(ctx.paymentDueAt),
            totalAmount: formatMoney(ctx.totalAmount, ctx.currency),
          },
        })
      }
    } catch (emailErr) {
      console.error('[bookings.accept] email dispatch failed', { bookingId, emailErr })
    }

    return NextResponse.json(data)
  } catch (err) {
    console.error('[bookings.accept] unexpected error', { userId: requester.userId, bookingId, err })
    return NextResponse.json({ error: 'Could not accept this booking — please try again' }, { status: 500 })
  }
}
