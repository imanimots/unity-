import { describe, it, expect } from 'vitest'
import { MockSubscriptionBillingProvider } from '../mock-provider'

describe('MockSubscriptionBillingProvider (category: Billing)', () => {
  const provider = new MockSubscriptionBillingProvider()

  it('1. is named "mock" -- never a real vendor name anywhere in this module', () => {
    expect(provider.name).toBe('mock')
  })

  it('2. succeeds deterministically when no scenario (or "success") is requested', async () => {
    const r = await provider.chargePlan({ merchantId: 'm1', planId: 'pro', amountCents: 19900, currency: 'ZAR' })
    expect(r.status).toBe('succeeded')
    expect(r.providerReference).toMatch(/^mock_subscription_charge_/)
  })

  it('3. fails deterministically when "declined" is requested -- never randomly', async () => {
    const r = await provider.chargePlan({ merchantId: 'm1', planId: 'pro', amountCents: 19900, currency: 'ZAR', mockScenario: 'declined' })
    expect(r.status).toBe('failed')
    expect(r.failureReason).toBeTruthy()
    expect(r.providerReference).toMatch(/^mock_subscription_charge_failed_/)
  })

  it('4. never returns the same provider reference twice', async () => {
    const a = await provider.chargePlan({ merchantId: 'm1', planId: 'pro', amountCents: 19900, currency: 'ZAR' })
    const b = await provider.chargePlan({ merchantId: 'm1', planId: 'pro', amountCents: 19900, currency: 'ZAR' })
    expect(a.providerReference).not.toBe(b.providerReference)
  })
})
