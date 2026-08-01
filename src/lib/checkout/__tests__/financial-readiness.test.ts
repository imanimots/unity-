import { describe, it, expect } from 'vitest'
import { deriveFinancialReadiness, type FinancialReadinessInput } from '../financial-readiness'

const base: FinancialReadinessInput = {
  bookingStatus: 'accepted',
  renterTotalAmount: 2500,
  workflowStatus: null,
  rentalPaymentStatus: null,
  depositRequired: true,
  depositPaymentStatus: null,
}

describe('deriveFinancialReadiness (category: Success)', () => {
  it('1. is not_prepared before checkout has ever been attempted on a not-yet-accepted booking', () => {
    expect(deriveFinancialReadiness({ ...base, bookingStatus: 'requested' })).toBe('not_prepared')
  })

  it('2. is awaiting_payment once accepted but no workflow row exists yet', () => {
    expect(deriveFinancialReadiness(base)).toBe('awaiting_payment')
  })

  it('3. is processing while the workflow is mid-flight', () => {
    expect(deriveFinancialReadiness({ ...base, workflowStatus: 'processing' })).toBe('processing')
  })

  it('4. is financially_ready once rental captured and deposit authorised', () => {
    expect(
      deriveFinancialReadiness({ ...base, workflowStatus: 'completed', rentalPaymentStatus: 'captured', depositPaymentStatus: 'authorised' })
    ).toBe('financially_ready')
  })

  it('5. is financially_ready for a zero-deposit booking once rental is captured, without requiring a deposit payment', () => {
    expect(
      deriveFinancialReadiness({ ...base, depositRequired: false, workflowStatus: 'completed', rentalPaymentStatus: 'captured', depositPaymentStatus: null })
    ).toBe('financially_ready')
  })

  it('6. is no_payment_required when the booking total is zero or less', () => {
    expect(deriveFinancialReadiness({ ...base, renterTotalAmount: 0 })).toBe('no_payment_required')
  })
})

describe('deriveFinancialReadiness (category: Declines)', () => {
  it('7. is payment_failed_terminal when the rental charge failed terminally', () => {
    expect(deriveFinancialReadiness({ ...base, workflowStatus: 'failed_terminal', rentalPaymentStatus: 'failed' })).toBe('payment_failed_terminal')
  })

  it('8. is deposit_failed_terminal when rental succeeded but deposit failed terminally', () => {
    expect(
      deriveFinancialReadiness({ ...base, workflowStatus: 'failed_terminal', rentalPaymentStatus: 'captured', depositPaymentStatus: 'failed' })
    ).toBe('deposit_failed_terminal')
  })

  it('9. attributes a terminal failure to the rental step whenever rental has not reached captured, even if deposit somehow already failed', () => {
    expect(
      deriveFinancialReadiness({ ...base, workflowStatus: 'failed_terminal', rentalPaymentStatus: 'pending', depositPaymentStatus: 'failed' })
    ).toBe('payment_failed_terminal')
  })

  it('10. terminal declines never resolve to financially_ready', () => {
    const result = deriveFinancialReadiness({ ...base, workflowStatus: 'failed_terminal', rentalPaymentStatus: 'failed' })
    expect(result).not.toBe('financially_ready')
  })
})

describe('deriveFinancialReadiness (category: Retryable Failure)', () => {
  it('11. is payment_failed_retryable for a retryable rental failure', () => {
    expect(deriveFinancialReadiness({ ...base, workflowStatus: 'failed_retryable', rentalPaymentStatus: 'failed' })).toBe('payment_failed_retryable')
  })

  it('12. is deposit_failed_retryable when rental succeeded but deposit failed retryably', () => {
    expect(
      deriveFinancialReadiness({ ...base, workflowStatus: 'failed_retryable', rentalPaymentStatus: 'captured', depositPaymentStatus: 'failed' })
    ).toBe('deposit_failed_retryable')
  })

  it('13. keeps the rental payment status of "captured" visible even while the deposit step is retrying', () => {
    const result = deriveFinancialReadiness({ ...base, workflowStatus: 'failed_retryable', rentalPaymentStatus: 'captured', depositPaymentStatus: 'failed' })
    expect(result).toBe('deposit_failed_retryable')
    expect(result).not.toBe('payment_failed_retryable')
  })

  it('14. a completed workflow with an inconsistent payment state falls back to processing rather than falsely claiming readiness', () => {
    expect(
      deriveFinancialReadiness({ ...base, workflowStatus: 'completed', rentalPaymentStatus: 'pending', depositPaymentStatus: null })
    ).toBe('processing')
  })

  it('15. retryable failures never resolve to financially_ready', () => {
    expect(deriveFinancialReadiness({ ...base, workflowStatus: 'failed_retryable', rentalPaymentStatus: 'failed' })).not.toBe('financially_ready')
  })
})

describe('deriveFinancialReadiness (category: Timeout)', () => {
  it('16. a provider timeout on the rental step surfaces the same as any other retryable rental failure', () => {
    expect(deriveFinancialReadiness({ ...base, workflowStatus: 'failed_retryable', rentalPaymentStatus: 'pending' })).toBe('payment_failed_retryable')
  })

  it('17. a provider timeout on the deposit step surfaces as deposit_failed_retryable once rental already captured', () => {
    expect(
      deriveFinancialReadiness({ ...base, workflowStatus: 'failed_retryable', rentalPaymentStatus: 'captured', depositPaymentStatus: 'pending' })
    ).toBe('deposit_failed_retryable')
  })

  it('18. a timed-out workflow is always retryable, never terminal, by construction of the derivation', () => {
    const result = deriveFinancialReadiness({ ...base, workflowStatus: 'failed_retryable', rentalPaymentStatus: 'pending' })
    expect(result).not.toBe('payment_failed_terminal')
    expect(result).not.toBe('deposit_failed_terminal')
  })
})

describe('deriveFinancialReadiness (category: Expiry -- Step 6)', () => {
  it('19. is expired_unpaid when paymentExpired is true, regardless of workflow/payment state', () => {
    expect(deriveFinancialReadiness({ ...base, paymentExpired: true })).toBe('expired_unpaid')
  })

  it('20. paymentExpired overrides an otherwise-processing state', () => {
    expect(deriveFinancialReadiness({ ...base, workflowStatus: 'processing', paymentExpired: true })).toBe('expired_unpaid')
  })

  it('21. paymentExpired overrides an otherwise-retryable-failure state', () => {
    expect(
      deriveFinancialReadiness({ ...base, workflowStatus: 'failed_retryable', rentalPaymentStatus: 'failed', paymentExpired: true })
    ).toBe('expired_unpaid')
  })

  it('22. paymentExpired is false/absent by default -- existing callers that never pass it are unaffected', () => {
    expect(deriveFinancialReadiness(base)).not.toBe('expired_unpaid')
  })

  it('23. expired_unpaid never resolves to financially_ready even if payments look complete (defensive -- should not happen in practice, but the expiry flag wins)', () => {
    expect(
      deriveFinancialReadiness({
        ...base,
        workflowStatus: 'completed',
        rentalPaymentStatus: 'captured',
        depositPaymentStatus: 'authorised',
        paymentExpired: true,
      })
    ).toBe('expired_unpaid')
  })
})
