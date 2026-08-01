import type { BookingLifecycleStatus } from '@/lib/bookings/status-labels'
import type { KycStatus } from '@/types'
import { isKycApproved } from '@/lib/verification/eligibility'
import { deriveFinancialReadiness, type FinancialReadinessState, type PaymentStatus, type WorkflowStatus } from './financial-readiness'

export type CheckoutAllowedAction = 'initiate' | 'retry' | 'view_result'

export interface CheckoutEligibilityInput {
  authenticated: boolean
  requesterId: string | null
  booking: {
    renterId: string
    status: BookingLifecycleStatus
    renterTotalAmount: number | null
    depositAmountSnapshot: number | null
    paymentExpiredAt?: string | null
  } | null
  renterKycStatus: KycStatus | null
  workflowStatus: WorkflowStatus
  rentalPaymentStatus: PaymentStatus
  depositPaymentStatus: PaymentStatus
}

export interface CheckoutEligibilityResult {
  eligible: boolean
  reasons: string[]
  existingPaymentStatus: PaymentStatus
  existingDepositStatus: PaymentStatus
  workflowStatus: WorkflowStatus
  readiness: FinancialReadinessState
  allowedActions: CheckoutAllowedAction[]
}

/**
 * The ONE server-authoritative checkout eligibility function, per Step
 * 5's requirement. Never duplicated in a React component -- the browser
 * only ever displays this result, it cannot override it (every mutating
 * route re-runs this same check server-side before doing anything).
 */
export function checkCheckoutEligibility(input: CheckoutEligibilityInput): CheckoutEligibilityResult {
  const reasons: string[] = []

  if (!input.authenticated || !input.requesterId) {
    reasons.push('You must be signed in.')
  }

  if (!input.booking) {
    reasons.push('Booking not found.')
    return {
      eligible: false,
      reasons,
      existingPaymentStatus: null,
      existingDepositStatus: null,
      workflowStatus: null,
      readiness: 'not_prepared',
      allowedActions: [],
    }
  }

  const { booking } = input

  if (input.requesterId && booking.renterId !== input.requesterId) {
    reasons.push('This booking does not belong to you.')
  }

  if (!isKycApproved(input.renterKycStatus)) {
    reasons.push('Identity verification must be approved before checkout.')
  }

  const depositRequired = (booking.depositAmountSnapshot ?? 0) > 0
  const readiness = deriveFinancialReadiness({
    bookingStatus: booking.status,
    renterTotalAmount: booking.renterTotalAmount,
    workflowStatus: input.workflowStatus,
    rentalPaymentStatus: input.rentalPaymentStatus,
    depositRequired,
    depositPaymentStatus: input.depositPaymentStatus,
    paymentExpired: Boolean(booking.paymentExpiredAt),
  })

  if (readiness === 'expired_unpaid') {
    reasons.push('This booking\'s payment deadline has passed and it can no longer be paid through checkout.')
    return {
      eligible: false,
      reasons,
      existingPaymentStatus: input.rentalPaymentStatus,
      existingDepositStatus: input.depositPaymentStatus,
      workflowStatus: input.workflowStatus,
      readiness,
      allowedActions: [],
    }
  }

  if (readiness === 'no_payment_required' || readiness === 'financially_ready') {
    reasons.push('This booking has already completed its required financial authorization.')
    return {
      eligible: false,
      reasons,
      existingPaymentStatus: input.rentalPaymentStatus,
      existingDepositStatus: input.depositPaymentStatus,
      workflowStatus: input.workflowStatus,
      readiness,
      allowedActions: ['view_result'],
    }
  }

  if (readiness === 'payment_failed_terminal' || readiness === 'deposit_failed_terminal') {
    reasons.push('This booking\'s payment was declined and cannot be retried. Please contact the merchant or make a new booking request.')
    return {
      eligible: false,
      reasons,
      existingPaymentStatus: input.rentalPaymentStatus,
      existingDepositStatus: input.depositPaymentStatus,
      workflowStatus: input.workflowStatus,
      readiness,
      allowedActions: [],
    }
  }

  if (booking.status !== 'accepted' && input.workflowStatus === null) {
    reasons.push(`This booking is not in a state that allows checkout (status: ${booking.status}).`)
  }

  if (booking.renterTotalAmount === null) {
    reasons.push('This booking has no financial summary yet.')
  }

  const eligible = reasons.length === 0
  const allowedActions: CheckoutAllowedAction[] = eligible ? (input.workflowStatus ? ['retry'] : ['initiate']) : []

  return {
    eligible,
    reasons,
    existingPaymentStatus: input.rentalPaymentStatus,
    existingDepositStatus: input.depositPaymentStatus,
    workflowStatus: input.workflowStatus,
    readiness,
    allowedActions,
  }
}
