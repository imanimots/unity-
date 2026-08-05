import { describe, it, expect } from 'vitest'
import { deriveBarterFinancialReadiness } from '../financial-readiness'

describe('deriveBarterFinancialReadiness', () => {
  it('returns no_payment_required when there is nothing to pay', () => {
    const state = deriveBarterFinancialReadiness({ depositRequirements: [], cashAdjustmentRequired: false, cashAdjustmentStatus: null })
    expect(state).toBe('no_payment_required')
  })

  it('returns awaiting_payment when a deposit is still pending', () => {
    const state = deriveBarterFinancialReadiness({
      depositRequirements: [{ payer: 'party_a', status: 'pending' }],
      cashAdjustmentRequired: false,
      cashAdjustmentStatus: null,
    })
    expect(state).toBe('awaiting_payment')
  })

  it('returns financially_ready once a single required deposit is authorised', () => {
    const state = deriveBarterFinancialReadiness({
      depositRequirements: [{ payer: 'party_a', status: 'authorised' }],
      cashAdjustmentRequired: false,
      cashAdjustmentStatus: null,
    })
    expect(state).toBe('financially_ready')
  })

  it('requires BOTH deposits authorised for a two-sided deposit before it is ready', () => {
    const state = deriveBarterFinancialReadiness({
      depositRequirements: [
        { payer: 'party_a', status: 'authorised' },
        { payer: 'party_b', status: 'pending' },
      ],
      cashAdjustmentRequired: false,
      cashAdjustmentStatus: null,
    })
    expect(state).toBe('awaiting_payment')
  })

  it('returns financially_ready once both deposits are authorised', () => {
    const state = deriveBarterFinancialReadiness({
      depositRequirements: [
        { payer: 'party_a', status: 'authorised' },
        { payer: 'party_b', status: 'authorised' },
      ],
      cashAdjustmentRequired: false,
      cashAdjustmentStatus: null,
    })
    expect(state).toBe('financially_ready')
  })

  it('requires the cash adjustment to be captured, not just authorised', () => {
    const state = deriveBarterFinancialReadiness({ depositRequirements: [], cashAdjustmentRequired: true, cashAdjustmentStatus: 'pending' })
    expect(state).toBe('awaiting_payment')
  })

  it('returns financially_ready once the cash adjustment is captured', () => {
    const state = deriveBarterFinancialReadiness({ depositRequirements: [], cashAdjustmentRequired: true, cashAdjustmentStatus: 'captured' })
    expect(state).toBe('financially_ready')
  })

  it('requires both a deposit and a captured cash adjustment when both apply', () => {
    const state = deriveBarterFinancialReadiness({
      depositRequirements: [{ payer: 'party_a', status: 'authorised' }],
      cashAdjustmentRequired: true,
      cashAdjustmentStatus: 'pending',
    })
    expect(state).toBe('awaiting_payment')
  })

  it('returns payment_failed when a deposit failed', () => {
    const state = deriveBarterFinancialReadiness({
      depositRequirements: [{ payer: 'party_a', status: 'failed' }],
      cashAdjustmentRequired: false,
      cashAdjustmentStatus: null,
    })
    expect(state).toBe('payment_failed')
  })

  it('returns payment_failed when the cash adjustment failed', () => {
    const state = deriveBarterFinancialReadiness({ depositRequirements: [], cashAdjustmentRequired: true, cashAdjustmentStatus: 'failed' })
    expect(state).toBe('payment_failed')
  })

  it('treats released deposits as ready (a completed trade returns deposits)', () => {
    const state = deriveBarterFinancialReadiness({
      depositRequirements: [{ payer: 'party_a', status: 'released' }],
      cashAdjustmentRequired: false,
      cashAdjustmentStatus: null,
    })
    expect(state).toBe('financially_ready')
  })
})
