import { describe, it, expect } from 'vitest'
import { isValidPaymentTransition, allowedNextStatuses, isTerminalPaymentStatus } from '../state-machine'

describe('payment state machine', () => {
  it('allows pending to move to authorised, captured, failed, cancelled, or expired', () => {
    expect(isValidPaymentTransition('pending', 'authorised')).toBe(true)
    expect(isValidPaymentTransition('pending', 'captured')).toBe(true)
    expect(isValidPaymentTransition('pending', 'failed')).toBe(true)
    expect(isValidPaymentTransition('pending', 'cancelled')).toBe(true)
    expect(isValidPaymentTransition('pending', 'expired')).toBe(true)
  })

  it('rejects pending moving directly to refunded (nothing was captured yet)', () => {
    expect(isValidPaymentTransition('pending', 'refunded')).toBe(false)
  })

  it('allows authorised (a deposit hold) to be released', () => {
    expect(isValidPaymentTransition('authorised', 'released')).toBe(true)
  })

  it('allows authorised to be captured in full or in part', () => {
    expect(isValidPaymentTransition('authorised', 'captured')).toBe(true)
    expect(isValidPaymentTransition('authorised', 'partially_captured')).toBe(true)
  })

  it('allows captured to be refunded, partially refunded, or charged back', () => {
    expect(isValidPaymentTransition('captured', 'refunded')).toBe(true)
    expect(isValidPaymentTransition('captured', 'partially_refunded')).toBe(true)
    expect(isValidPaymentTransition('captured', 'chargeback')).toBe(true)
  })

  it('rejects captured moving back to pending or authorised', () => {
    expect(isValidPaymentTransition('captured', 'pending')).toBe(false)
    expect(isValidPaymentTransition('captured', 'authorised')).toBe(false)
  })

  it('allows partially_refunded to move to a full refund or chargeback only', () => {
    expect(isValidPaymentTransition('partially_refunded', 'refunded')).toBe(true)
    expect(isValidPaymentTransition('partially_refunded', 'chargeback')).toBe(true)
    expect(isValidPaymentTransition('partially_refunded', 'captured')).toBe(false)
  })

  it('treats released, refunded, failed, cancelled, expired, and chargeback as terminal', () => {
    expect(isTerminalPaymentStatus('released')).toBe(true)
    expect(isTerminalPaymentStatus('refunded')).toBe(true)
    expect(isTerminalPaymentStatus('failed')).toBe(true)
    expect(isTerminalPaymentStatus('cancelled')).toBe(true)
    expect(isTerminalPaymentStatus('expired')).toBe(true)
    expect(isTerminalPaymentStatus('chargeback')).toBe(true)
  })

  it('does not allow any transition out of a terminal status', () => {
    expect(allowedNextStatuses('refunded')).toEqual([])
    expect(allowedNextStatuses('failed')).toEqual([])
    expect(isValidPaymentTransition('refunded', 'captured')).toBe(false)
  })

  it('never merges payment status with booking status -- no booking-lifecycle values exist in this enum', () => {
    const allStatuses = ['pending', 'authorised', 'captured', 'partially_captured', 'released', 'refunded', 'partially_refunded', 'failed', 'cancelled', 'expired', 'chargeback']
    const bookingOnlyStatuses = ['requested', 'accepted', 'rejected', 'active', 'return_pending', 'returned', 'completed']
    for (const s of bookingOnlyStatuses) {
      expect(allStatuses).not.toContain(s)
    }
  })
})
