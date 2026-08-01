import type { SupabaseClient } from '@supabase/supabase-js'
import { loadBookingFinancialState } from './load-financial-state'
import { deriveFinancialReadiness, type FinancialReadinessState } from './financial-readiness'

export interface FinancialReadinessGateResult {
  ready: boolean
  readiness: FinancialReadinessState
  reason: string | null
}

/**
 * The ONE trusted server helper for "is this booking financially ready to
 * start?" (Step 6). Wraps the existing Step 5 loadBookingFinancialState +
 * deriveFinancialReadiness -- never re-queries payments/financial_workflows
 * itself, so every caller (start-rental route, dashboards' allowed-action
 * calculations) shares the exact same derivation instead of each
 * duplicating the payment lookup and status logic. Ready means
 * 'financially_ready' or 'no_payment_required' -- every other state
 * (awaiting_payment, processing, either failure family, expired_unpaid)
 * blocks a start.
 */
export async function getBookingFinancialEligibility(admin: SupabaseClient, bookingId: string): Promise<FinancialReadinessGateResult> {
  const state = await loadBookingFinancialState(admin, bookingId)
  if (!state.booking) {
    return { ready: false, readiness: 'not_prepared', reason: 'Booking not found.' }
  }

  const readiness = deriveFinancialReadiness({
    bookingStatus: state.booking.status,
    renterTotalAmount: state.booking.renterTotalAmount,
    workflowStatus: state.workflowStatus,
    rentalPaymentStatus: state.rentalPaymentStatus,
    depositRequired: (state.booking.depositAmountSnapshot ?? 0) > 0,
    depositPaymentStatus: state.depositPaymentStatus,
    paymentExpired: Boolean(state.booking.paymentExpiredAt),
  })

  const ready = readiness === 'financially_ready' || readiness === 'no_payment_required'
  return { ready, readiness, reason: ready ? null : REASONS[readiness] }
}

const REASONS: Record<FinancialReadinessState, string> = {
  not_prepared: 'This booking has not been accepted yet.',
  awaiting_payment: 'The renter has not completed checkout yet.',
  processing: 'Payment is still processing.',
  payment_failed_retryable: 'The rental payment has not succeeded yet.',
  payment_failed_terminal: 'The rental payment was declined.',
  deposit_failed_retryable: 'The deposit authorization has not succeeded yet.',
  deposit_failed_terminal: 'The deposit authorization was declined.',
  financially_ready: '',
  no_payment_required: '',
  expired_unpaid: 'The payment deadline for this booking passed before checkout was completed.',
}
