import type { BookingLifecycleStatus } from '@/lib/bookings/status-labels'

/**
 * The ONE derived helper for booking financial readiness, per Step 5's
 * requirement. Never a persisted column on bookings -- always re-derived
 * from financial_workflows/payments state so there is exactly one source
 * of truth. Reused by Step 6.
 */
export type FinancialReadinessState =
  | 'not_prepared'
  | 'awaiting_payment'
  | 'processing'
  | 'payment_failed_retryable'
  | 'payment_failed_terminal'
  | 'deposit_failed_retryable'
  | 'deposit_failed_terminal'
  | 'financially_ready'
  | 'no_payment_required'
  | 'expired_unpaid'

export type PaymentStatus =
  | 'pending'
  | 'authorised'
  | 'captured'
  | 'partially_captured'
  | 'released'
  | 'refunded'
  | 'partially_refunded'
  | 'failed'
  | 'cancelled'
  | 'expired'
  | 'chargeback'
  | null

export type WorkflowStatus = 'pending' | 'processing' | 'completed' | 'failed_retryable' | 'failed_terminal' | null

export interface FinancialReadinessInput {
  bookingStatus: BookingLifecycleStatus
  renterTotalAmount: number | null
  workflowStatus: WorkflowStatus
  rentalPaymentStatus: PaymentStatus
  depositRequired: boolean
  depositPaymentStatus: PaymentStatus
  /**
   * True once bookings.payment_expired_at is set (Step 6) -- distinct
   * from a lifecycle-status check because 'expired' is also used for the
   * unrelated stale-request expiry (Phase 2B, expires_at /
   * expire_stale_booking_requests()). Authoritative once true: checked
   * first, before any other derivation.
   */
  paymentExpired?: boolean
}

export function deriveFinancialReadiness(input: FinancialReadinessInput): FinancialReadinessState {
  const { bookingStatus, renterTotalAmount, workflowStatus, rentalPaymentStatus, depositRequired, depositPaymentStatus, paymentExpired } = input

  if (paymentExpired) return 'expired_unpaid'

  if (renterTotalAmount !== null && renterTotalAmount <= 0) return 'no_payment_required'

  // Checkout is only reachable once the booking has been accepted -- for
  // any earlier lifecycle status there is nothing to prepare yet.
  if (bookingStatus !== 'accepted' && !workflowStatus) return 'not_prepared'

  if (!workflowStatus) return 'awaiting_payment'

  if (workflowStatus === 'pending' || workflowStatus === 'processing') return 'processing'

  if (workflowStatus === 'completed') {
    if (rentalPaymentStatus === 'captured' && (!depositRequired || depositPaymentStatus === 'authorised')) {
      return 'financially_ready'
    }
    // Defensive -- a workflow marked completed should always have both
    // required steps in their target status; if not, surface it as still
    // processing rather than claiming readiness.
    return 'processing'
  }

  // workflowStatus is failed_retryable or failed_terminal -- attribute the
  // failure to whichever step has not reached its target status. Rental
  // is always attempted first, so a failure with the rental payment still
  // short of "captured" is a rental failure; otherwise it's the deposit.
  const isTerminal = workflowStatus === 'failed_terminal'
  if (rentalPaymentStatus !== 'captured') {
    return isTerminal ? 'payment_failed_terminal' : 'payment_failed_retryable'
  }
  return isTerminal ? 'deposit_failed_terminal' : 'deposit_failed_retryable'
}

export const FINANCIAL_READINESS_RENTER_COPY: Record<FinancialReadinessState, { label: string; description: string }> = {
  not_prepared: { label: 'Checkout not yet available', description: 'This booking is not yet accepted.' },
  awaiting_payment: { label: 'Checkout required', description: 'Complete checkout to secure this booking.' },
  processing: { label: 'Payment processing', description: 'Your payment is being processed.' },
  payment_failed_retryable: { label: 'Rental payment failed — retry available', description: 'A temporary issue stopped your rental payment. You can try again.' },
  payment_failed_terminal: { label: 'Rental payment declined', description: 'Your rental payment was declined and cannot be retried on this booking.' },
  deposit_failed_retryable: { label: 'Deposit authorization failed — retry available', description: 'Your rental payment succeeded, but the deposit hold failed temporarily. You can try again.' },
  deposit_failed_terminal: { label: 'Deposit authorization declined', description: 'Your rental payment succeeded, but the deposit hold was declined and cannot be retried on this booking.' },
  financially_ready: { label: 'Financially ready', description: 'Payment and deposit are complete. This booking is ready to start.' },
  no_payment_required: { label: 'No payment required', description: 'This booking does not require payment.' },
  expired_unpaid: { label: 'Payment expired', description: 'The payment deadline for this booking has passed. It can no longer be paid — please make a new booking request if you still want to rent this item.' },
}

export const FINANCIAL_READINESS_MERCHANT_COPY: Record<FinancialReadinessState, { label: string; description: string }> = {
  not_prepared: { label: 'Awaiting acceptance', description: '' },
  awaiting_payment: { label: 'Renter payment pending', description: 'Waiting for the renter to complete checkout.' },
  processing: { label: 'Payment processing', description: 'The renter’s payment is being processed.' },
  payment_failed_retryable: { label: 'Payment incomplete', description: 'The renter’s payment did not go through yet; they can retry.' },
  payment_failed_terminal: { label: 'Payment failed', description: 'The renter’s payment was declined.' },
  deposit_failed_retryable: { label: 'Deposit incomplete', description: 'Rental payment succeeded; the deposit hold did not go through yet.' },
  deposit_failed_terminal: { label: 'Deposit failed', description: 'Rental payment succeeded; the deposit hold was declined.' },
  financially_ready: { label: 'Financially ready', description: 'Renter payment and deposit are complete.' },
  no_payment_required: { label: 'No payment required', description: '' },
  expired_unpaid: { label: 'Expired — unpaid', description: 'The renter did not complete payment before the deadline. These dates are available again.' },
}
