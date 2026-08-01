import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { checkCheckoutEligibility } from '@/lib/checkout/eligibility'
import { deriveFinancialReadiness } from '@/lib/checkout/financial-readiness'
import { loadBookingFinancialState } from '@/lib/checkout/load-financial-state'
import { isMockScenarioSelectionAllowed } from '@/lib/checkout/test-scenario'
import { triggerLazyExpirySweep } from '@/lib/bookings/lazy-expiry'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * GET /api/bookings/[id]/financial-status -- read-only. Used by the
 * checkout page on load/refresh (so an interrupted request or a page
 * reload never loses the financial result -- it's always re-derived from
 * financial_workflows/payments, never client state) and by the renter's
 * own polling after a retry. Merchants read the same booking's status via
 * the dashboard's own server-side query, not this route (this route is
 * renter-scoped only, matching checkout's own ownership rule).
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { id: bookingId } = await params
  if (!/^[0-9a-f-]{36}$/i.test(bookingId)) {
    return NextResponse.json({ error: 'Invalid booking id' }, { status: 400 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Checkout is not configured' }, { status: 503 })
  }

  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
  }

  const { createClient: createServiceClient } = await import('@supabase/supabase-js')
  const admin = createServiceClient(url, serviceKey)

  await triggerLazyExpirySweep(admin)

  const state = await loadBookingFinancialState(admin, bookingId)
  if (!state.booking || state.booking.renterId !== requester.userId) {
    return NextResponse.json({ error: 'Booking not found' }, { status: 404 })
  }

  const eligibility = checkCheckoutEligibility({
    authenticated: true,
    requesterId: requester.userId,
    booking: {
      renterId: state.booking.renterId,
      status: state.booking.status,
      renterTotalAmount: state.booking.renterTotalAmount,
      depositAmountSnapshot: state.booking.depositAmountSnapshot,
      paymentExpiredAt: state.booking.paymentExpiredAt,
    },
    renterKycStatus: requester.profile.kyc_status,
    workflowStatus: state.workflowStatus,
    rentalPaymentStatus: state.rentalPaymentStatus,
    depositPaymentStatus: state.depositPaymentStatus,
  })

  const readiness = deriveFinancialReadiness({
    bookingStatus: state.booking.status,
    renterTotalAmount: state.booking.renterTotalAmount,
    workflowStatus: state.workflowStatus,
    rentalPaymentStatus: state.rentalPaymentStatus,
    depositRequired: (state.booking.depositAmountSnapshot ?? 0) > 0,
    depositPaymentStatus: state.depositPaymentStatus,
    paymentExpired: Boolean(state.booking.paymentExpiredAt),
  })

  return NextResponse.json({
    booking: {
      id: state.booking.id,
      bookingReference: state.booking.bookingReference,
      listingId: state.booking.listingId,
      status: state.booking.status,
      startAt: state.booking.startAt,
      endAt: state.booking.endAt,
      paymentDueAt: state.booking.paymentDueAt,
      paymentExpiredAt: state.booking.paymentExpiredAt,
      subtotalAmount: state.booking.subtotalAmount,
      depositAmountSnapshot: state.booking.depositAmountSnapshot,
      renterTotalAmount: state.booking.renterTotalAmount,
      platformFeeAmount: state.booking.platformFeeAmount,
      currency: state.booking.currency,
      rateAmount: state.booking.rateAmount,
      rateUnit: state.booking.rateUnit,
      durationUnits: state.booking.durationUnits,
    },
    eligibility,
    readiness,
    rentalPaymentStatus: state.rentalPaymentStatus,
    depositPaymentStatus: state.depositPaymentStatus,
    rentalFailureReason: state.rentalFailureReason,
    depositFailureReason: state.depositFailureReason,
    testModeAvailable: isMockScenarioSelectionAllowed(),
  })
}
