import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { checkoutRequestSchema } from '@/lib/checkout/validation'
import { checkCheckoutEligibility } from '@/lib/checkout/eligibility'
import { deriveFinancialReadiness, type PaymentStatus } from '@/lib/checkout/financial-readiness'
import { loadBookingFinancialState } from '@/lib/checkout/load-financial-state'
import { isMockScenarioSelectionAllowed, mapCheckoutScenarioToProviderScenarios } from '@/lib/checkout/test-scenario'
import { authorizeBookingFinancials, OrchestrationError, isRetryableOrchestrationError } from '@/lib/payments/orchestrator'
import { triggerLazyExpirySweep } from '@/lib/bookings/lazy-expiry'
import { checkAndRecordLateSuccessIfExpired } from '@/lib/bookings/late-payment-reconciliation'
import { sendTemplate, loadBookingEmailContext } from '@/lib/email'
import { blockIfCannotTransact } from '@/lib/admin/account-status'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/bookings/[id]/checkout -- the single trusted route for both
 * initiating checkout and retrying an incomplete/retryable financial
 * workflow. authorizeBookingFinancials() is itself resumable (see
 * docs/FINANCIAL_ORCHESTRATION.md), so one route safely covers both cases
 * per Step 5's "one safe idempotent route" guidance -- a fresh call
 * prepares + authorizes from scratch, a retry call resumes whichever step
 * did not complete, and an exact idempotency-key replay against an
 * already-completed workflow returns the cached result.
 *
 * The browser sends only idempotency_key and (mock mode only) a
 * normalized test_scenario -- amounts, statuses, provider references, and
 * ids are always derived server-side from the booking's own immutable
 * financial snapshot and current payment/workflow state, never accepted
 * from the request body.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: bookingId } = await params
  if (!/^[0-9a-f-]{36}$/i.test(bookingId)) {
    return NextResponse.json({ error: 'Invalid booking id' }, { status: 400 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Checkout is not configured' }, { status: 503 })
  }

  const rate = checkRateLimit(`bookings:checkout:${getClientKey(request)}`, 20, 60_000)
  if (!rate.allowed) {
    return NextResponse.json({ error: 'Too many requests — please slow down' }, { status: 429 })
  }

  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
  }
  if (requester.profile.role !== 'renter' && requester.profile.role !== 'both') {
    return NextResponse.json({ error: 'Only renter accounts can check out a booking' }, { status: 403 })
  }
  const blocked = blockIfCannotTransact(requester.profile)
  if (blocked) return blocked

  let body: unknown
  try {
    body = await request.json()
  } catch {
    body = {}
  }
  const parsed = checkoutRequestSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  if (parsed.data.test_scenario && !isMockScenarioSelectionAllowed()) {
    return NextResponse.json({ error: 'Test scenario selection is not permitted in this environment' }, { status: 400 })
  }

  try {
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

    if (!eligibility.eligible) {
      return NextResponse.json({ error: eligibility.reasons.join(' '), reasons: eligibility.reasons, readiness: eligibility.readiness }, { status: 422 })
    }

    const { rentalScenario, depositScenario } = mapCheckoutScenarioToProviderScenarios(parsed.data.test_scenario)

    const result = await authorizeBookingFinancials(
      { admin, testRentalScenario: rentalScenario, testDepositScenario: depositScenario },
      bookingId,
      parsed.data.idempotency_key
    )

    // Race guard: the payment deadline may have passed while this
    // authorization was in flight (a concurrent expiry sweep). The
    // booking must never be silently reactivated -- see
    // docs/PAYMENT_READINESS.md "Late provider events".
    const { lateSuccess } = await checkAndRecordLateSuccessIfExpired(admin, bookingId)
    if (lateSuccess) {
      return NextResponse.json({
        status: 'late_success_after_expiry',
        readiness: 'expired_unpaid',
        rentalStatus: result.rentalStatus,
        depositStatus: result.depositStatus,
        error: 'Your payment was processed, but this booking\'s payment deadline had already passed and it remains expired. Please contact support.',
      })
    }

    const readiness = deriveFinancialReadiness({
      bookingStatus: state.booking.status,
      renterTotalAmount: state.booking.renterTotalAmount,
      workflowStatus: 'completed',
      rentalPaymentStatus: result.rentalStatus as PaymentStatus,
      depositRequired: (state.booking.depositAmountSnapshot ?? 0) > 0,
      depositPaymentStatus: (result.depositStatus ?? null) as PaymentStatus,
    })

    try {
      const ctx = await loadBookingEmailContext(admin, bookingId)
      if (ctx) {
        await sendTemplate(admin, {
          eventType: 'booking.financially_ready',
          templateId: 'booking-financially-ready-renter',
          recipientUserId: ctx.renterId,
          relatedEntityType: 'booking',
          relatedEntityId: ctx.bookingId,
          vars: { renterName: ctx.renterName, listingTitle: ctx.listingTitle, bookingReference: ctx.bookingReference },
        })
        await sendTemplate(admin, {
          eventType: 'booking.financially_ready',
          templateId: 'booking-financially-ready-merchant',
          recipientUserId: ctx.merchantId,
          relatedEntityType: 'booking',
          relatedEntityId: ctx.bookingId,
          vars: { merchantName: ctx.merchantName, listingTitle: ctx.listingTitle, bookingReference: ctx.bookingReference },
        })
      }
    } catch (emailErr) {
      console.error('[bookings.checkout] financially-ready email dispatch failed', { bookingId, emailErr })
    }

    return NextResponse.json({
      status: 'success',
      readiness,
      rentalStatus: result.rentalStatus,
      depositStatus: result.depositStatus,
    })
  } catch (err) {
    if (err instanceof OrchestrationError) {
      console.error('[bookings.checkout] orchestration error', { bookingId, code: err.code, message: err.message })

      if (isRetryableOrchestrationError(err.code)) {
        await dispatchCheckoutFailureEmail(url, serviceKey, bookingId, 'payment.retryable_failure', 'payment-retryable-failure-renter')
        return NextResponse.json(
          { status: 'failed_retryable', readiness: 'payment_failed_retryable', error: 'A temporary issue stopped this payment. Please try again.' },
          { status: 503 }
        )
      }

      if (err.code === 'provider_declined' || err.code === 'terminal_provider_error') {
        const rentalCaptured = await isRentalCaptured(url, serviceKey, bookingId)
        await dispatchCheckoutFailureEmail(
          url,
          serviceKey,
          bookingId,
          rentalCaptured ? 'deposit.failed' : 'payment.declined',
          rentalCaptured ? 'deposit-failed-renter' : 'payment-declined-renter'
        )
        return NextResponse.json({ status: 'failed_terminal', error: err.message }, { status: 200 })
      }

      if (err.code === 'duplicate_workflow_conflict') {
        return NextResponse.json({ error: 'This booking\'s payment has already failed terminally and cannot be retried' }, { status: 409 })
      }

      return NextResponse.json({ error: 'Checkout could not be completed — please try again' }, { status: 500 })
    }

    console.error('[bookings.checkout] unexpected error', { bookingId, err })
    return NextResponse.json({ error: 'Checkout could not be completed — please try again' }, { status: 500 })
  }
}

async function isRentalCaptured(url: string, serviceKey: string, bookingId: string): Promise<boolean> {
  const { createClient: createServiceClient } = await import('@supabase/supabase-js')
  const admin = createServiceClient(url, serviceKey)
  const { data } = await admin.from('payments').select('status').eq('booking_id', bookingId).eq('payment_type', 'rental_charge').maybeSingle()
  return data?.status === 'captured'
}

async function dispatchCheckoutFailureEmail(
  url: string,
  serviceKey: string,
  bookingId: string,
  eventType: 'payment.declined' | 'payment.retryable_failure' | 'deposit.failed',
  templateId: string
): Promise<void> {
  try {
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    const admin = createServiceClient(url, serviceKey)
    const ctx = await loadBookingEmailContext(admin, bookingId)
    if (!ctx) return
    await sendTemplate(admin, {
      eventType,
      templateId,
      recipientUserId: ctx.renterId,
      relatedEntityType: 'booking',
      relatedEntityId: ctx.bookingId,
      vars: { renterName: ctx.renterName, listingTitle: ctx.listingTitle, bookingReference: ctx.bookingReference },
    })
  } catch (emailErr) {
    console.error('[bookings.checkout] failure email dispatch failed', { bookingId, eventType, emailErr })
  }
}
