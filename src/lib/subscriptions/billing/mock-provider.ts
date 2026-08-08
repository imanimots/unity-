import { randomUUID } from 'crypto'
import type { SubscriptionBillingProvider, SubscriptionChargeInput, SubscriptionChargeResult } from './provider'

/**
 * Fully functional but entirely simulated -- no network call, no real
 * money, mirrors src/lib/payments/providers/mock-provider.ts's own
 * deterministic-by-scenario shape. mockScenario is selected explicitly
 * by the caller -- never randomly.
 */
export class MockSubscriptionBillingProvider implements SubscriptionBillingProvider {
  readonly name = 'mock'

  async chargePlan(input: SubscriptionChargeInput): Promise<SubscriptionChargeResult> {
    if (input.mockScenario === 'declined') {
      return { providerReference: `mock_subscription_charge_failed_${randomUUID()}`, status: 'failed', failureReason: 'mock billing declined' }
    }
    return { providerReference: `mock_subscription_charge_${randomUUID()}`, status: 'succeeded' }
  }
}
