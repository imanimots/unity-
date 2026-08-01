import { describe, it, expect } from 'vitest'
import { computeReleaseDepositHash, computeCaptureDepositHash, computeOrchestratorPayoutHash } from '../idempotency'

describe('orchestrator idempotency hashes', () => {
  it('computeReleaseDepositHash is deterministic for the same payment', () => {
    expect(computeReleaseDepositHash('p1')).toBe('1758c1a0daf57c9f8e732e1286676c26')
    expect(computeReleaseDepositHash('p1')).toBe(computeReleaseDepositHash('p1'))
  })

  it('computeReleaseDepositHash differs for a different payment', () => {
    expect(computeReleaseDepositHash('p1')).not.toBe(computeReleaseDepositHash('p2'))
  })

  it('computeCaptureDepositHash is deterministic for the same inputs', () => {
    expect(computeCaptureDepositHash('p1', 150, 'damage')).toBe('e54bf771e333375f4d92889da7e90f66')
  })

  it('computeCaptureDepositHash differs for a different amount', () => {
    const a = computeCaptureDepositHash('p1', 150, 'damage')
    const b = computeCaptureDepositHash('p1', 200, 'damage')
    expect(a).not.toBe(b)
  })

  it('computeOrchestratorPayoutHash is deterministic for the same booking', () => {
    expect(computeOrchestratorPayoutHash('b1')).toBe('3f97f1f114af2bcdaf94b8e61687932f')
  })
})
