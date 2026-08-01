import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  mapCheckoutScenarioToProviderScenarios,
  isMockScenarioSelectionAllowed,
  isCheckoutTestScenario,
  CHECKOUT_TEST_SCENARIOS,
} from '../test-scenario'

describe('mapCheckoutScenarioToProviderScenarios (category: Architecture)', () => {
  it('1. maps every one of the 7 catalogued scenarios to a concrete provider scenario pair (no scenario is unmapped)', () => {
    for (const scenario of CHECKOUT_TEST_SCENARIOS) {
      const mapped = mapCheckoutScenarioToProviderScenarios(scenario)
      expect(mapped.rentalScenario).toBeDefined()
    }
  })

  it('2. maps "rental_declined" so the rental step alone is declined', () => {
    expect(mapCheckoutScenarioToProviderScenarios('rental_declined')).toEqual({ rentalScenario: 'declined', depositScenario: 'success' })
  })

  it('3. maps "deposit_declined" so rental succeeds and only the deposit is declined', () => {
    expect(mapCheckoutScenarioToProviderScenarios('deposit_declined')).toEqual({ rentalScenario: 'success', depositScenario: 'declined' })
  })

  it('4. maps "zero_deposit_success" identically to "success" -- it is a booking precondition, not a distinct provider behaviour', () => {
    expect(mapCheckoutScenarioToProviderScenarios('zero_deposit_success')).toEqual(mapCheckoutScenarioToProviderScenarios('success'))
  })

  it('5. maps "timeout" to the same scenario for both rental and deposit, so it applies to whichever step is still pending on resume', () => {
    const mapped = mapCheckoutScenarioToProviderScenarios('timeout')
    expect(mapped.rentalScenario).toBe('timeout')
    expect(mapped.depositScenario).toBe('timeout')
  })

  it('6. returns undefined scenarios when no test scenario is supplied (real/default provider path)', () => {
    expect(mapCheckoutScenarioToProviderScenarios(undefined)).toEqual({ rentalScenario: undefined, depositScenario: undefined })
  })
})

describe('isCheckoutTestScenario', () => {
  it('7. accepts every catalogued scenario value', () => {
    for (const scenario of CHECKOUT_TEST_SCENARIOS) expect(isCheckoutTestScenario(scenario)).toBe(true)
  })

  it('8. rejects an arbitrary string', () => {
    expect(isCheckoutTestScenario('not_a_real_scenario')).toBe(false)
  })
})

describe('isMockScenarioSelectionAllowed (category: Security)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('9. is allowed when PAYMENT_PROVIDER=mock and NEXT_PUBLIC_PAYMENT_MODE=test', () => {
    vi.stubEnv('PAYMENT_PROVIDER', 'mock')
    vi.stubEnv('NEXT_PUBLIC_PAYMENT_MODE', 'test')
    expect(isMockScenarioSelectionAllowed()).toBe(true)
  })

  it('10. is blocked when PAYMENT_PROVIDER=peach even if payment mode claims test', () => {
    vi.stubEnv('PAYMENT_PROVIDER', 'peach')
    vi.stubEnv('NEXT_PUBLIC_PAYMENT_MODE', 'test')
    expect(isMockScenarioSelectionAllowed()).toBe(false)
  })

  it('11. is blocked when NEXT_PUBLIC_PAYMENT_MODE is explicitly "production", even with the mock provider selected', () => {
    vi.stubEnv('PAYMENT_PROVIDER', 'mock')
    vi.stubEnv('NEXT_PUBLIC_PAYMENT_MODE', 'production')
    expect(isMockScenarioSelectionAllowed()).toBe(false)
  })

  it('12. falls back to NODE_ENV=production as closed-by-default when the payment-mode var is unset entirely', () => {
    vi.stubEnv('PAYMENT_PROVIDER', 'mock')
    vi.stubEnv('NODE_ENV', 'production')
    expect(isMockScenarioSelectionAllowed()).toBe(false)
  })

  it('13. defaults open in a non-production environment with the mock provider and no explicit payment-mode var (local dev convenience)', () => {
    vi.stubEnv('PAYMENT_PROVIDER', 'mock')
    vi.stubEnv('NODE_ENV', 'test')
    expect(isMockScenarioSelectionAllowed()).toBe(true)
  })
})
