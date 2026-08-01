import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { createBookingRequestSchema } from '@/lib/bookings/validation'
import { mapBookingRpcError } from '@/lib/bookings/rpc-errors'
import { computeCreateBookingRequestHash, checkIdempotentReplay } from '@/lib/bookings/idempotency'
import { isKycApproved } from '@/lib/verification/eligibility'
import { triggerLazyExpirySweep } from '@/lib/bookings/lazy-expiry'
import { sendTemplate, loadBookingEmailContext } from '@/lib/email'
import { blockIfCannotCreate } from '@/lib/admin/account-status'

/**
 * POST /api/bookings -- create a booking request.
 * GET  /api/bookings -- list the caller's own bookings (as renter and/or
 * merchant).
 *
 * create_booking_request() (20260730000007_booking_rpcs.sql) is callable
 * only via the service role -- the renter must not be able to supply
 * merchant_id, price, deposit, or listing status directly, and the RPC's
 * own availability/eligibility checks must be the single enforcement
 * point, not something a direct RPC call could bypass. renter_id passed
 * to the RPC is always requester.userId from the verified session, never
 * a client-supplied value.
 */
export async function POST(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !anonKey || !serviceKey) {
    return NextResponse.json({ error: 'Booking storage is not configured' }, { status: 503 })
  }

  const rate = checkRateLimit(`bookings:create:${getClientKey(request)}`, 10, 60_000)
  if (!rate.allowed) {
    return NextResponse.json({ error: 'Too many requests — please slow down' }, { status: 429 })
  }

  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in to request a booking' }, { status: 401 })
  }
  if (requester.profile.role !== 'renter' && requester.profile.role !== 'both') {
    return NextResponse.json({ error: 'Only renter accounts can request bookings' }, { status: 403 })
  }
  const blocked = blockIfCannotCreate(requester.profile)
  if (blocked) return blocked

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const parsed = createBookingRequestSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid booking request', fieldErrors: parsed.error.flatten().fieldErrors },
      { status: 400 }
    )
  }

  try {
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    const admin = createServiceClient(url, serviceKey)

    const startAt = new Date(parsed.data.start_at)
    const endAt = new Date(parsed.data.end_at)

    if (parsed.data.idempotency_key) {
      const hash = computeCreateBookingRequestHash(parsed.data.listing_id, startAt, endAt, parsed.data.renter_message)
      const replay = await checkIdempotentReplay(admin, requester.userId, 'create_booking_request', parsed.data.idempotency_key, hash)
      if (replay.status === 'replay') return NextResponse.json(replay.result, { status: 201 })
      if (replay.status === 'conflict') {
        const mapped = mapBookingRpcError('idempotency key already used with a different request')
        return NextResponse.json({ error: mapped.error }, { status: mapped.status })
      }
    }

    // Step 4 eligibility rule: approved KYC required for renters at
    // booking request (docs/IDENTITY_VERIFICATION.md). Checked after the
    // idempotency replay above (an already-completed request must still
    // return its cached result even if the renter's KYC status changed
    // since) and before the RPC, mirroring the established ordering rule
    // for every mutation route in this codebase.
    if (!isKycApproved(requester.profile.kyc_status)) {
      return NextResponse.json({ error: 'Your identity must be verified before you can request a booking.' }, { status: 403 })
    }

    const { data, error } = await admin.rpc('create_booking_request', {
      p_renter_id: requester.userId,
      p_listing_id: parsed.data.listing_id,
      p_start_at: startAt.toISOString(),
      p_end_at: endAt.toISOString(),
      p_renter_message: parsed.data.renter_message ?? null,
      p_idempotency_key: parsed.data.idempotency_key ?? null,
    })

    if (error) {
      console.error('[bookings.create] RPC error', { userId: requester.userId, error })
      const mapped = mapBookingRpcError(error.message)
      return NextResponse.json({ error: mapped.error }, { status: mapped.status })
    }

    try {
      const ctx = await loadBookingEmailContext(admin, data.booking_id)
      if (ctx) {
        await sendTemplate(admin, {
          eventType: 'booking.requested',
          templateId: 'booking-requested-renter',
          recipientUserId: ctx.renterId,
          relatedEntityType: 'booking',
          relatedEntityId: ctx.bookingId,
          vars: { renterName: ctx.renterName, listingTitle: ctx.listingTitle, bookingReference: ctx.bookingReference },
        })
        await sendTemplate(admin, {
          eventType: 'booking.requested',
          templateId: 'booking-request-received-merchant',
          recipientUserId: ctx.merchantId,
          relatedEntityType: 'booking',
          relatedEntityId: ctx.bookingId,
          vars: { merchantName: ctx.merchantName, listingTitle: ctx.listingTitle, bookingReference: ctx.bookingReference, renterName: ctx.renterName },
        })
      }
    } catch (emailErr) {
      console.error('[bookings.create] email dispatch failed', { bookingId: data.booking_id, emailErr })
    }

    return NextResponse.json(data, { status: 201 })
  } catch (err) {
    console.error('[bookings.create] unexpected error', { userId: requester.userId, err })
    return NextResponse.json({ error: 'Could not submit your booking request — please try again' }, { status: 500 })
  }
}

export async function GET(request: NextRequest) {
  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
  }

  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  if (!supabase) {
    return NextResponse.json({ error: 'Booking storage is not configured' }, { status: 503 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (url && serviceKey) {
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    await triggerLazyExpirySweep(createServiceClient(url, serviceKey))
  }

  const roleParam = request.nextUrl.searchParams.get('role')
  const statusParam = request.nextUrl.searchParams.get('status')

  // RLS ("bookings: parties read") scopes this to rows where the caller is
  // renter_id or merchant_id regardless of the filter applied here.
  let query = supabase.from('bookings').select('*').order('created_at', { ascending: false })

  if (roleParam === 'renter') {
    query = query.eq('renter_id', requester.userId)
  } else if (roleParam === 'merchant') {
    query = query.eq('merchant_id', requester.userId)
  } else {
    query = query.or(`renter_id.eq.${requester.userId},merchant_id.eq.${requester.userId}`)
  }
  if (statusParam) {
    query = query.eq('status', statusParam)
  }

  const { data, error } = await query
  if (error) {
    console.error('[bookings.list] error', { userId: requester.userId, error })
    return NextResponse.json({ error: 'Could not load bookings' }, { status: 500 })
  }

  return NextResponse.json({ bookings: data ?? [] })
}
