import { describe, it, expect } from 'vitest'
import { MockAdvertisingBillingProvider } from '../providers/mock-provider'

describe('MockAdvertisingBillingProvider', () => {
  const provider = new MockAdvertisingBillingProvider()

  it('charge defaults to "success" when no scenario is given', async () => {
    const result = await provider.charge({ advertiserId: 'adv-1', campaignId: 'camp-1', amountCents: 5000, currency: 'ZAR' })
    expect(result.status).toBe('succeeded')
    expect(result.providerReference).toMatch(/^mock_ad_/)
  })

  it('charge with a "declined" scenario fails deterministically with a reason -- never randomness', async () => {
    const result = await provider.charge({ advertiserId: 'adv-1', campaignId: 'camp-1', amountCents: 5000, currency: 'ZAR', mockScenario: 'declined' })
    expect(result.status).toBe('failed')
    expect(result.failureReason).toBe('declined')
  })

  it('charge with a "timeout" scenario fails deterministically with a reason', async () => {
    const result = await provider.charge({ advertiserId: 'adv-1', campaignId: 'camp-1', amountCents: 5000, currency: 'ZAR', mockScenario: 'timeout' })
    expect(result.status).toBe('failed')
    expect(result.failureReason).toBe('timeout')
  })

  it('refund always succeeds deterministically -- no real money moves', async () => {
    const result = await provider.refund({ providerReference: 'mock_ad_1', amountCents: 5000, currency: 'ZAR' })
    expect(result.status).toBe('refunded')
    expect(result.providerReference).toMatch(/^mock_ad_refund_/)
  })
})
