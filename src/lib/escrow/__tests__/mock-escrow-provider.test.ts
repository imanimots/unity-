import { describe, it, expect } from 'vitest'
import { MockEscrowProvider } from '../providers/mock-escrow-provider'
import { UnsupportedTradeSafeProvider } from '../providers/tradesafe-provider'
import { EscrowNotImplementedError } from '../provider'
import { getEscrowProvider, listRegisteredEscrowProviders } from '../registry'

describe('MockEscrowProvider', () => {
  const provider = new MockEscrowProvider()

  it('is registered under the name "mock"', () => {
    expect(provider.name).toBe('mock')
  })

  it('createEscrowTransaction returns a pending, mock-prefixed reference', async () => {
    const result = await provider.createEscrowTransaction({ transactionType: 'sale', principalAmount: 500, secureTransactionFeeAmount: 0, currency: 'ZAR' })
    expect(result.status).toBe('pending')
    expect(result.providerReference).toMatch(/^mock_escrow_/)
  })

  it('the full custody lifecycle (fund -> release) succeeds deterministically', async () => {
    const fund = await provider.fundEscrowTransaction({ providerReference: 'mock_escrow_1', amount: 500, currency: 'ZAR' })
    expect(fund.status).toBe('funded')

    const release = await provider.releaseEscrowTransaction({ providerReference: 'mock_escrow_1', amount: 500, currency: 'ZAR' })
    expect(release.status).toBe('released')
  })

  it('refundEscrowTransaction succeeds', async () => {
    const refund = await provider.refundEscrowTransaction({ providerReference: 'mock_escrow_1', amount: 500, currency: 'ZAR' })
    expect(refund.status).toBe('refunded')
  })

  it('a "declined" mock scenario fails funding/release/refund with a reason', async () => {
    const fund = await provider.fundEscrowTransaction({ providerReference: 'ref', amount: 500, currency: 'ZAR', mockScenario: 'declined' })
    expect(fund.status).toBe('failed')
    expect(fund.failureReason).toBeTruthy()
  })

  it('healthCheck reports healthy', async () => {
    expect((await provider.healthCheck()).healthy).toBe(true)
  })

  it('capabilities reflect what the mock provider actually supports', () => {
    expect(provider.capabilities.supportsPartialRefund).toBe(true)
    expect(provider.capabilities.requiresWebhookConfirmation).toBe(false)
  })

  describe('verifyWebhook', () => {
    it('accepts a correctly signed webhook and extracts its event id', async () => {
      const result = await provider.verifyWebhook({
        rawBody: JSON.stringify({ event_id: 'evt_1' }),
        headers: { 'x-mock-signature': 'mock-signature' },
      })
      expect(result.valid).toBe(true)
      expect(result.providerEventId).toBe('evt_1')
    })

    it('rejects an incorrectly signed webhook', async () => {
      const result = await provider.verifyWebhook({ rawBody: JSON.stringify({ event_id: 'evt_1' }), headers: { 'x-mock-signature': 'forged' } })
      expect(result.valid).toBe(false)
    })
  })
})

describe('UnsupportedTradeSafeProvider (stub)', () => {
  const provider = new UnsupportedTradeSafeProvider()

  it('is registered under the name "tradesafe"', () => {
    expect(provider.name).toBe('tradesafe')
  })

  it('every money-moving method throws EscrowNotImplementedError -- no real TradeSafe integration exists', async () => {
    await expect(provider.createEscrowTransaction({ transactionType: 'sale', principalAmount: 500, secureTransactionFeeAmount: 0, currency: 'ZAR' })).rejects.toThrow(EscrowNotImplementedError)
    await expect(provider.fundEscrowTransaction({ providerReference: '', amount: 500, currency: 'ZAR' })).rejects.toThrow(EscrowNotImplementedError)
    await expect(provider.releaseEscrowTransaction({ providerReference: '', amount: 500, currency: 'ZAR' })).rejects.toThrow(EscrowNotImplementedError)
    await expect(provider.refundEscrowTransaction({ providerReference: '', amount: 500, currency: 'ZAR' })).rejects.toThrow(EscrowNotImplementedError)
    await expect(provider.verifyWebhook({ rawBody: '', headers: {} })).rejects.toThrow(EscrowNotImplementedError)
  })

  it('healthCheck reports unhealthy without throwing', async () => {
    const result = await provider.healthCheck()
    expect(result.healthy).toBe(false)
  })
})

describe('escrow provider registry', () => {
  it('registers both mock and tradesafe', () => {
    expect(listRegisteredEscrowProviders().sort()).toEqual(['mock', 'tradesafe'])
  })

  it('defaults to the mock provider when none is specified and no env override is set', () => {
    expect(getEscrowProvider().name).toBe('mock')
  })

  it('returns the requested provider by name', () => {
    expect(getEscrowProvider('tradesafe').name).toBe('tradesafe')
    expect(getEscrowProvider('mock').name).toBe('mock')
  })

  it('throws for an unknown provider name rather than silently falling back', () => {
    expect(() => getEscrowProvider('stripe')).toThrow(/Unknown escrow provider/)
  })
})
