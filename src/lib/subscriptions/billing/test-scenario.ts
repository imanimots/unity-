import type { SubscriptionMockScenario } from './provider'

export const SUBSCRIPTION_MOCK_SCENARIOS: SubscriptionMockScenario[] = ['success', 'declined']

export function isSubscriptionMockScenario(value: unknown): value is SubscriptionMockScenario {
  return typeof value === 'string' && (SUBSCRIPTION_MOCK_SCENARIOS as string[]).includes(value)
}

/**
 * Same double gate as src/lib/checkout/test-scenario.ts's
 * isMockScenarioSelectionAllowed(): scenario selection is permitted only
 * when the active subscription billing provider is "mock" AND the
 * environment is explicitly test/development -- never in production,
 * regardless of what a request body claims.
 */
export function isSubscriptionMockScenarioSelectionAllowed(): boolean {
  const provider = process.env.SUBSCRIPTION_BILLING_PROVIDER || 'mock'
  if (provider !== 'mock') return false

  const paymentMode = process.env.NEXT_PUBLIC_PAYMENT_MODE
  if (paymentMode) return paymentMode === 'test'

  return process.env.NODE_ENV !== 'production'
}
