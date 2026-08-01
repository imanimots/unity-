import { describe, it, expect, beforeEach, vi } from 'vitest'

describe('BOOKING_PAYMENT_DEADLINE_HOURS (category: Acceptance)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('1. defaults to 24 when unset', async () => {
    vi.stubEnv('BOOKING_PAYMENT_DEADLINE_HOURS', '')
    const { BOOKING_PAYMENT_DEADLINE_HOURS } = await import('../payment-deadline')
    expect(BOOKING_PAYMENT_DEADLINE_HOURS).toBe(24)
  })

  it('2. reads a valid positive integer from the env var', async () => {
    vi.stubEnv('BOOKING_PAYMENT_DEADLINE_HOURS', '12')
    const { BOOKING_PAYMENT_DEADLINE_HOURS } = await import('../payment-deadline')
    expect(BOOKING_PAYMENT_DEADLINE_HOURS).toBe(12)
  })

  it('3. falls back to 24 for a non-numeric value rather than producing NaN', async () => {
    vi.stubEnv('BOOKING_PAYMENT_DEADLINE_HOURS', 'not-a-number')
    const { BOOKING_PAYMENT_DEADLINE_HOURS } = await import('../payment-deadline')
    expect(BOOKING_PAYMENT_DEADLINE_HOURS).toBe(24)
  })

  it('4. falls back to 24 for a zero or negative value', async () => {
    vi.stubEnv('BOOKING_PAYMENT_DEADLINE_HOURS', '0')
    const zero = await import('../payment-deadline')
    expect(zero.BOOKING_PAYMENT_DEADLINE_HOURS).toBe(24)

    vi.resetModules()
    vi.stubEnv('BOOKING_PAYMENT_DEADLINE_HOURS', '-5')
    const negative = await import('../payment-deadline')
    expect(negative.BOOKING_PAYMENT_DEADLINE_HOURS).toBe(24)
  })
})
