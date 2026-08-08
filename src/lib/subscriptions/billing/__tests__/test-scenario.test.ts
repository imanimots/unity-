import { describe, it, expect, vi, afterEach } from 'vitest'
import { isSubscriptionMockScenarioSelectionAllowed, isSubscriptionMockScenario } from '../test-scenario'

describe('isSubscriptionMockScenarioSelectionAllowed (category: Security)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('1. is closed by default in a production build', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('SUBSCRIPTION_BILLING_PROVIDER', 'mock')
    expect(isSubscriptionMockScenarioSelectionAllowed()).toBe(false)
  })

  it('2. is closed when a non-mock billing provider is selected, regardless of environment', () => {
    vi.stubEnv('SUBSCRIPTION_BILLING_PROVIDER', 'real-billing-provider')
    vi.stubEnv('NODE_ENV', 'development')
    expect(isSubscriptionMockScenarioSelectionAllowed()).toBe(false)
  })

  it('3. is open in a non-production environment with the mock provider and no explicit payment-mode var', () => {
    vi.stubEnv('SUBSCRIPTION_BILLING_PROVIDER', 'mock')
    vi.stubEnv('NODE_ENV', 'test')
    expect(isSubscriptionMockScenarioSelectionAllowed()).toBe(true)
  })

  it('4. NEXT_PUBLIC_PAYMENT_MODE explicitly overrides NODE_ENV in both directions', () => {
    vi.stubEnv('SUBSCRIPTION_BILLING_PROVIDER', 'mock')
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_PAYMENT_MODE', 'test')
    expect(isSubscriptionMockScenarioSelectionAllowed()).toBe(true)
  })

  it('5. an explicit non-test payment mode closes selection even in a non-production environment', () => {
    vi.stubEnv('SUBSCRIPTION_BILLING_PROVIDER', 'mock')
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('NEXT_PUBLIC_PAYMENT_MODE', 'live')
    expect(isSubscriptionMockScenarioSelectionAllowed()).toBe(false)
  })
})

describe('isSubscriptionMockScenario (category: Validation)', () => {
  it('6. accepts only the known scenario values', () => {
    expect(isSubscriptionMockScenario('success')).toBe(true)
    expect(isSubscriptionMockScenario('declined')).toBe(true)
    expect(isSubscriptionMockScenario('always_succeed')).toBe(false)
    expect(isSubscriptionMockScenario(123)).toBe(false)
  })
})
