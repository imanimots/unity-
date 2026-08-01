import { describe, it, expect } from 'vitest'
import { checkCheckoutEligibility, type CheckoutEligibilityInput } from '../eligibility'

const baseInput: CheckoutEligibilityInput = {
  authenticated: true,
  requesterId: 'renter-1',
  booking: {
    renterId: 'renter-1',
    status: 'accepted',
    renterTotalAmount: 2500,
    depositAmountSnapshot: 1000,
  },
  renterKycStatus: 'approved',
  workflowStatus: null,
  rentalPaymentStatus: null,
  depositPaymentStatus: null,
}

describe('checkCheckoutEligibility (category: Eligibility)', () => {
  it('1. is eligible for a KYC-approved renter on their own accepted booking with no prior attempt', () => {
    const result = checkCheckoutEligibility(baseInput)
    expect(result.eligible).toBe(true)
    expect(result.reasons).toEqual([])
    expect(result.allowedActions).toEqual(['initiate'])
  })

  it('2. is ineligible when unauthenticated', () => {
    const result = checkCheckoutEligibility({ ...baseInput, authenticated: false, requesterId: null })
    expect(result.eligible).toBe(false)
    expect(result.reasons.some((r) => r.includes('signed in'))).toBe(true)
  })

  it('3. is ineligible when the booking does not exist', () => {
    const result = checkCheckoutEligibility({ ...baseInput, booking: null })
    expect(result.eligible).toBe(false)
    expect(result.allowedActions).toEqual([])
  })

  it('4. is ineligible when KYC is not approved', () => {
    const result = checkCheckoutEligibility({ ...baseInput, renterKycStatus: 'pending' })
    expect(result.eligible).toBe(false)
    expect(result.reasons.some((r) => r.includes('Identity verification'))).toBe(true)
  })

  it('5. is ineligible when the booking is not yet accepted (still requested)', () => {
    const result = checkCheckoutEligibility({ ...baseInput, booking: { ...baseInput.booking!, status: 'requested' } })
    expect(result.eligible).toBe(false)
    expect(result.reasons.some((r) => r.includes('not in a state'))).toBe(true)
  })

  it('6. allows retry when a retryable rental failure exists', () => {
    const result = checkCheckoutEligibility({ ...baseInput, workflowStatus: 'failed_retryable', rentalPaymentStatus: 'failed' })
    expect(result.eligible).toBe(true)
    expect(result.allowedActions).toEqual(['retry'])
  })

  it('7. blocks retry when the workflow has failed terminally', () => {
    const result = checkCheckoutEligibility({ ...baseInput, workflowStatus: 'failed_terminal', rentalPaymentStatus: 'failed' })
    expect(result.eligible).toBe(false)
    expect(result.allowedActions).toEqual([])
    expect(result.reasons.some((r) => r.includes('cannot be retried'))).toBe(true)
  })

  it('8. is ineligible (already complete) once financially ready, offering view_result only', () => {
    const result = checkCheckoutEligibility({
      ...baseInput,
      workflowStatus: 'completed',
      rentalPaymentStatus: 'captured',
      depositPaymentStatus: 'authorised',
    })
    expect(result.eligible).toBe(false)
    expect(result.allowedActions).toEqual(['view_result'])
  })

  it('9. eligible with a completed rental but retryable deposit failure', () => {
    const result = checkCheckoutEligibility({
      ...baseInput,
      workflowStatus: 'failed_retryable',
      rentalPaymentStatus: 'captured',
      depositPaymentStatus: 'failed',
    })
    expect(result.eligible).toBe(true)
    expect(result.allowedActions).toEqual(['retry'])
  })

  it('10. surfaces multiple simultaneous reasons rather than stopping at the first', () => {
    const result = checkCheckoutEligibility({ ...baseInput, authenticated: false, requesterId: null, renterKycStatus: 'rejected' })
    expect(result.reasons.length).toBeGreaterThanOrEqual(2)
  })
})

describe('checkCheckoutEligibility (category: Security)', () => {
  it('11. blocks checkout when the requester is not the booking renter', () => {
    const result = checkCheckoutEligibility({ ...baseInput, requesterId: 'someone-else' })
    expect(result.eligible).toBe(false)
    expect(result.reasons.some((r) => r.includes('does not belong to you'))).toBe(true)
  })

  it('12. never returns an "initiate" or "retry" action once the workflow has failed terminally, even with KYC approved', () => {
    const result = checkCheckoutEligibility({ ...baseInput, workflowStatus: 'failed_terminal', rentalPaymentStatus: 'failed' })
    expect(result.allowedActions).not.toContain('initiate')
    expect(result.allowedActions).not.toContain('retry')
  })

  it('13. never returns an actionable state once already financially ready, preventing a duplicate charge attempt', () => {
    const result = checkCheckoutEligibility({
      ...baseInput,
      workflowStatus: 'completed',
      rentalPaymentStatus: 'captured',
      depositPaymentStatus: 'authorised',
    })
    expect(result.allowedActions).not.toContain('initiate')
    expect(result.allowedActions).not.toContain('retry')
  })
})

describe('checkCheckoutEligibility (category: Expiry -- Step 6)', () => {
  it('14. blocks checkout once the payment deadline has passed, even if the booking is otherwise eligible', () => {
    const result = checkCheckoutEligibility({
      ...baseInput,
      booking: { ...baseInput.booking!, paymentExpiredAt: '2026-01-01T00:00:00Z' },
    })
    expect(result.eligible).toBe(false)
    expect(result.readiness).toBe('expired_unpaid')
    expect(result.allowedActions).toEqual([])
    expect(result.reasons.some((r) => r.includes('deadline has passed'))).toBe(true)
  })

  it('15. blocks a retry attempt on an expired booking even if the workflow was only retryable, not terminal', () => {
    const result = checkCheckoutEligibility({
      ...baseInput,
      workflowStatus: 'failed_retryable',
      rentalPaymentStatus: 'failed',
      booking: { ...baseInput.booking!, paymentExpiredAt: '2026-01-01T00:00:00Z' },
    })
    expect(result.eligible).toBe(false)
    expect(result.readiness).toBe('expired_unpaid')
  })

  it('16. a booking with no paymentExpiredAt is unaffected by the expiry check', () => {
    const result = checkCheckoutEligibility(baseInput)
    expect(result.readiness).not.toBe('expired_unpaid')
  })
})
