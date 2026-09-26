import { describe, it, expect } from 'vitest'
import {
  classifyCapturedRtbInstallmentPayment,
  isCapturedRtbDepositUnfunded,
  type RtbInstallmentExceptionCandidate,
  type RtbInstallmentRow,
} from '../exceptions-service'

/**
 * P5D-B.3: DB-free tests for the pure RTB classification helpers,
 * consistent with this file's own established convention
 * (deriveOrderFinancialReadiness in orders-service.ts, etc.) of testing
 * derived logic directly rather than mocking listOperationalExceptions'
 * full multi-wave Supabase query orchestration. Neither function under
 * test takes any webhook-related parameter at all -- the only inputs
 * are payment/installment/agreement rows -- so every result proven here
 * is, by construction, derived purely from persisted financial/domain
 * state, never from payment_webhook_events.status.
 */

function payment(overrides: Partial<RtbInstallmentExceptionCandidate> = {}): RtbInstallmentExceptionCandidate {
  return { id: 'pay-1', rent_to_buy_agreement_id: 'agr-1', amount: '250.00', metadata: {}, ...overrides }
}

function installment(overrides: Partial<RtbInstallmentRow> = {}): RtbInstallmentRow {
  return { sequence: 1, principal_amount: '100.00', status: 'scheduled', payment_id: null, ...overrides }
}

describe('classifyCapturedRtbInstallmentPayment -- legacy uncorrelated (category A)', () => {
  it('1. neither correlation key present surfaces the legacy exception', () => {
    const result = classifyCapturedRtbInstallmentPayment(payment({ metadata: {} }), [])
    expect(result).toEqual({ type: 'rtb_installment_legacy_uncorrelated', summary: expect.any(String) })
  })

  it('2. a valid single-installment sequence never enters the legacy category', () => {
    const result = classifyCapturedRtbInstallmentPayment(payment({ metadata: { rent_to_buy_installment_sequence: 3 } }), [])
    expect(result).toBeNull()
  })

  it('3. a valid, healthy, fully-completed payoff-correlated payment never enters the legacy category', () => {
    const rows = [installment({ sequence: 2, principal_amount: '100.00', status: 'paid', payment_id: 'pay-1' }), installment({ sequence: 3, principal_amount: '150.00', status: 'paid', payment_id: 'pay-1' })]
    const result = classifyCapturedRtbInstallmentPayment(payment({ amount: '250.00', metadata: { rent_to_buy_payoff_sequences: [2, 3] } }), rows)
    expect(result).toBeNull()
  })
})

describe('classifyCapturedRtbInstallmentPayment -- payoff payment_conflict (category B)', () => {
  it('5. a snapshotted sequence already paid by a different payment surfaces payment_conflict', () => {
    const rows = [installment({ sequence: 2, principal_amount: '100.00', status: 'paid', payment_id: 'other-pay' }), installment({ sequence: 3, principal_amount: '150.00', status: 'scheduled' })]
    const result = classifyCapturedRtbInstallmentPayment(payment({ metadata: { rent_to_buy_payoff_sequences: [2, 3] } }), rows)
    expect(result?.type).toBe('rtb_payoff_payment_conflict')
  })

  it('6. a snapshotted sequence already paid by THIS SAME payment is not a conflict', () => {
    const rows = [installment({ sequence: 2, principal_amount: '100.00', status: 'paid', payment_id: 'pay-1' }), installment({ sequence: 3, principal_amount: '150.00', status: 'scheduled' })]
    const result = classifyCapturedRtbInstallmentPayment(payment({ metadata: { rent_to_buy_payoff_sequences: [2, 3] } }), rows)
    expect(result).toBeNull() // still scheduled overall -- awaiting progression, not a permanent condition
  })

  it('7. a scheduled row alone (awaiting progression) never surfaces a conflict', () => {
    const rows = [installment({ sequence: 2, principal_amount: '100.00', status: 'scheduled' }), installment({ sequence: 3, principal_amount: '150.00', status: 'scheduled' })]
    const result = classifyCapturedRtbInstallmentPayment(payment({ metadata: { rent_to_buy_payoff_sequences: [2, 3] } }), rows)
    expect(result).toBeNull()
  })

  it('8. an installment row outside the snapshot is ignored even if it is conflicted', () => {
    const rows = [
      installment({ sequence: 2, principal_amount: '100.00', status: 'scheduled' }),
      installment({ sequence: 3, principal_amount: '150.00', status: 'scheduled' }),
      installment({ sequence: 99, principal_amount: '999.00', status: 'paid', payment_id: 'unrelated-payment' }),
    ]
    const result = classifyCapturedRtbInstallmentPayment(payment({ metadata: { rent_to_buy_payoff_sequences: [2, 3] } }), rows)
    expect(result).toBeNull()
  })
})

describe('classifyCapturedRtbInstallmentPayment -- payoff invalid_snapshot (category C)', () => {
  it('9. incompatible correlation metadata (both keys present) surfaces invalid_snapshot', () => {
    const result = classifyCapturedRtbInstallmentPayment(payment({ metadata: { rent_to_buy_installment_sequence: 1, rent_to_buy_payoff_sequences: [2, 3] } }), [])
    expect(result?.type).toBe('rtb_payoff_invalid_snapshot')
  })

  it('10a. an empty payoff snapshot array surfaces invalid_snapshot', () => {
    const result = classifyCapturedRtbInstallmentPayment(payment({ metadata: { rent_to_buy_payoff_sequences: [] } }), [])
    expect(result?.type).toBe('rtb_payoff_invalid_snapshot')
  })

  it('10b. a malformed (non-array) payoff snapshot surfaces invalid_snapshot, never throws', () => {
    const result = classifyCapturedRtbInstallmentPayment(payment({ metadata: { rent_to_buy_payoff_sequences: 'not-an-array' } }), [])
    expect(result?.type).toBe('rtb_payoff_invalid_snapshot')
  })

  it('10c. a payoff snapshot containing non-integer/zero/negative elements surfaces invalid_snapshot, never throws', () => {
    const result = classifyCapturedRtbInstallmentPayment(payment({ metadata: { rent_to_buy_payoff_sequences: [1, 'x', -2, 0] } }), [])
    expect(result?.type).toBe('rtb_payoff_invalid_snapshot')
  })

  it('11. a snapshotted sequence with no matching installment row (cardinality mismatch) surfaces invalid_snapshot', () => {
    const rows = [installment({ sequence: 2, principal_amount: '100.00', status: 'scheduled' })]
    const result = classifyCapturedRtbInstallmentPayment(payment({ metadata: { rent_to_buy_payoff_sequences: [2, 3] } }), rows)
    expect(result?.type).toBe('rtb_payoff_invalid_snapshot')
  })

  it('12. a payment amount that does not match the exact snapshot principal sum surfaces invalid_snapshot', () => {
    const rows = [installment({ sequence: 2, principal_amount: '100.00', status: 'scheduled' }), installment({ sequence: 3, principal_amount: '150.00', status: 'scheduled' })]
    const result = classifyCapturedRtbInstallmentPayment(payment({ amount: '999.00', metadata: { rent_to_buy_payoff_sequences: [2, 3] } }), rows)
    expect(result?.type).toBe('rtb_payoff_invalid_snapshot')
  })

  it('13. malformed metadata (not an object) never throws and is treated as no correlation at all', () => {
    expect(() => classifyCapturedRtbInstallmentPayment(payment({ metadata: null }), [])).not.toThrow()
    const result = classifyCapturedRtbInstallmentPayment(payment({ metadata: null }), [])
    expect(result?.type).toBe('rtb_installment_legacy_uncorrelated')
  })

  it('14. a valid, fully-completed payoff payment (amount matches, no conflict) never surfaces invalid_snapshot', () => {
    const rows = [installment({ sequence: 2, principal_amount: '100.00', status: 'paid', payment_id: 'pay-1' }), installment({ sequence: 3, principal_amount: '150.00', status: 'paid', payment_id: 'pay-1' })]
    const result = classifyCapturedRtbInstallmentPayment(payment({ amount: '250.00', metadata: { rent_to_buy_payoff_sequences: [2, 3] } }), rows)
    expect(result).toBeNull()
  })
})

describe('classifyCapturedRtbInstallmentPayment -- outcome precedence matches the P5D-M3 RPC exactly', () => {
  it('a cardinality mismatch on one sequence takes precedence over a genuine conflict on another -- resolves to invalid_snapshot, never payment_conflict', () => {
    // Snapshot [2, 3]: sequence 3 has no matching row at all (cardinality
    // issue), while sequence 2 is conflicted (paid by another payment).
    // payoff_rent_to_buy_agreement checks cardinality BEFORE payment
    // conflict -- this must resolve the same way.
    const rows = [installment({ sequence: 2, principal_amount: '100.00', status: 'paid', payment_id: 'other-pay' })]
    const result = classifyCapturedRtbInstallmentPayment(payment({ metadata: { rent_to_buy_payoff_sequences: [2, 3] } }), rows)
    expect(result?.type).toBe('rtb_payoff_invalid_snapshot')
  })

  it('a genuine conflict takes precedence over an amount mismatch -- resolves to payment_conflict, never invalid_snapshot', () => {
    // payoff_rent_to_buy_agreement checks payment_conflict BEFORE amount.
    const rows = [installment({ sequence: 2, principal_amount: '100.00', status: 'paid', payment_id: 'other-pay' }), installment({ sequence: 3, principal_amount: '150.00', status: 'scheduled' })]
    const result = classifyCapturedRtbInstallmentPayment(payment({ amount: '999.00', metadata: { rent_to_buy_payoff_sequences: [2, 3] } }), rows)
    expect(result?.type).toBe('rtb_payoff_payment_conflict')
  })
})

describe('isCapturedRtbDepositUnfunded (category D)', () => {
  it('15. a captured deposit with deposit_funded_at NULL is flagged', () => {
    const result = isCapturedRtbDepositUnfunded({ amount: '500.00', agreement: { security_deposit_amount: '500.00', deposit_funded_at: null } })
    expect(result).toBe(true)
  })

  it('16. once deposit_funded_at is populated, the exception no longer applies', () => {
    const result = isCapturedRtbDepositUnfunded({ amount: '500.00', agreement: { security_deposit_amount: '500.00', deposit_funded_at: '2026-09-01T00:00:00Z' } })
    expect(result).toBe(false)
  })

  it('17. an amount mismatch is excluded, never misreported as a normal unfunded deposit', () => {
    const result = isCapturedRtbDepositUnfunded({ amount: '999.00', agreement: { security_deposit_amount: '500.00', deposit_funded_at: null } })
    expect(result).toBe(false)
  })

  it('18. a missing agreement or unconfigured security deposit is excluded', () => {
    expect(isCapturedRtbDepositUnfunded({ amount: '500.00', agreement: null })).toBe(false)
    expect(isCapturedRtbDepositUnfunded({ amount: '500.00', agreement: { security_deposit_amount: null, deposit_funded_at: null } })).toBe(false)
  })
})

describe('durability -- classification depends only on persisted payment/installment/agreement state', () => {
  it('the classification functions have no parameter representing webhook inbox state at all', () => {
    // Structural proof: both functions' signatures accept only
    // payment/installment/agreement data. There is no webhook-status
    // input to even pass, so the same captured-payment state always
    // classifies the same way regardless of whether the triggering
    // webhook event was ever marked processed.
    const capturedButNeverProgressed = classifyCapturedRtbInstallmentPayment(payment({ metadata: {} }), [])
    expect(capturedButNeverProgressed?.type).toBe('rtb_installment_legacy_uncorrelated')
    const depositCapturedButNeverProgressed = isCapturedRtbDepositUnfunded({ amount: '500.00', agreement: { security_deposit_amount: '500.00', deposit_funded_at: null } })
    expect(depositCapturedButNeverProgressed).toBe(true)
  })
})
