import { randomUUID } from 'crypto'
import type { AdvertisingBillingProvider, AdvertisingChargeInput, AdvertisingChargeResult, AdvertisingRefundInput, AdvertisingRefundResult } from '../provider'

/**
 * Fully functional, deterministic, in-memory simulation -- no real
 * card charge, no real bank transfer, no real provider API. `mockScenario`
 * is consulted explicitly (never randomness), mirroring
 * src/lib/payments/providers/mock-provider.ts's own MockScenario
 * convention exactly.
 */
export class MockAdvertisingBillingProvider implements AdvertisingBillingProvider {
  async charge(input: AdvertisingChargeInput): Promise<AdvertisingChargeResult> {
    const scenario = input.mockScenario ?? 'success'
    if (scenario === 'declined') {
      return { providerReference: `mock_ad_${randomUUID()}`, status: 'failed', failureReason: 'declined' }
    }
    if (scenario === 'timeout') {
      return { providerReference: `mock_ad_${randomUUID()}`, status: 'failed', failureReason: 'timeout' }
    }
    return { providerReference: `mock_ad_${randomUUID()}`, status: 'succeeded' }
  }

  async refund(_input: AdvertisingRefundInput): Promise<AdvertisingRefundResult> {
    return { providerReference: `mock_ad_refund_${randomUUID()}`, status: 'refunded' }
  }
}
