import { describe, it, expect } from 'vitest'
import { MockProvider } from '../providers/mock-provider'
import { PeachPaymentsProvider } from '../providers/peach-provider'
import { NotImplementedError } from '../provider'
import { getPaymentProvider, listRegisteredProviders } from '../registry'

describe('MockProvider', () => {
  const provider = new MockProvider()

  it('is registered under the name "mock"', () => {
    expect(provider.name).toBe('mock')
  })

  it('createPaymentIntent returns a pending, mock-prefixed reference', async () => {
    const result = await provider.createPaymentIntent({ bookingId: 'b1', amount: 500, currency: 'ZAR' })
    expect(result.status).toBe('pending')
    expect(result.providerReference).toMatch(/^mock_intent_/)
  })

  it('the full deposit lifecycle (authorize -> capture -> release) all succeed deterministically', async () => {
    const auth = await provider.authorizeDeposit({ paymentId: 'p1', providerReference: '', amount: 500, currency: 'ZAR' })
    expect(auth.status).toBe('authorised')

    const capture = await provider.captureDeposit({ paymentId: 'p1', providerReference: auth.providerReference, amount: 500, currency: 'ZAR' })
    expect(capture.status).toBe('captured')

    const release = await provider.releaseDeposit({ paymentId: 'p1', providerReference: auth.providerReference, amount: 500, currency: 'ZAR' })
    expect(release.status).toBe('released')
  })

  it('chargeRental succeeds and refund succeeds', async () => {
    const charge = await provider.chargeRental({ paymentId: 'p1', providerReference: '', amount: 1000, currency: 'ZAR' })
    expect(charge.status).toBe('captured')

    const refund = await provider.refund({ paymentId: 'p1', providerReference: charge.providerReference, amount: 1000, currency: 'ZAR' })
    expect(refund.status).toBe('completed')
  })

  it('createMerchantPayout returns a pending mock reference', async () => {
    const payout = await provider.createMerchantPayout({ merchantId: 'm1', amount: 950, currency: 'ZAR' })
    expect(payout.status).toBe('pending')
    expect(payout.providerReference).toMatch(/^mock_payout_/)
  })

  it('healthCheck reports healthy', async () => {
    expect((await provider.healthCheck()).healthy).toBe(true)
  })

  describe('verifyWebhook — signature validation and duplicate/event-id extraction', () => {
    it('accepts a correctly signed webhook and extracts its event id', async () => {
      const result = await provider.verifyWebhook({
        rawBody: JSON.stringify({ event_id: 'evt_1', type: 'payment.captured' }),
        headers: { 'x-mock-signature': 'mock-signature' },
      })
      expect(result.valid).toBe(true)
      expect(result.providerEventId).toBe('evt_1')
    })

    it('rejects a webhook with an incorrect signature', async () => {
      const result = await provider.verifyWebhook({
        rawBody: JSON.stringify({ event_id: 'evt_1' }),
        headers: { 'x-mock-signature': 'forged-signature' },
      })
      expect(result.valid).toBe(false)
    })

    it('rejects a webhook with a missing signature header', async () => {
      const result = await provider.verifyWebhook({ rawBody: JSON.stringify({ event_id: 'evt_1' }), headers: {} })
      expect(result.valid).toBe(false)
    })

    it('rejects a malformed (non-JSON) body without throwing', async () => {
      const result = await provider.verifyWebhook({ rawBody: 'not json at all', headers: { 'x-mock-signature': 'mock-signature' } })
      expect(result.valid).toBe(false)
      expect(result.providerEventId).toBeNull()
    })

    it('same event id verified twice produces the same providerEventId, enabling caller-side dedup', async () => {
      const body = JSON.stringify({ event_id: 'evt_replay', type: 'payment.captured' })
      const headers = { 'x-mock-signature': 'mock-signature' }
      const first = await provider.verifyWebhook({ rawBody: body, headers })
      const second = await provider.verifyWebhook({ rawBody: body, headers })
      expect(first.providerEventId).toBe(second.providerEventId)
    })
  })
})

describe('PeachPaymentsProvider (stub)', () => {
  const provider = new PeachPaymentsProvider()

  it('is registered under the name "peach"', () => {
    expect(provider.name).toBe('peach')
  })

  it('every money-moving method throws NotImplementedError -- no real API calls in this phase', async () => {
    await expect(provider.createPaymentIntent({ bookingId: 'b1', amount: 500, currency: 'ZAR' })).rejects.toThrow(NotImplementedError)
    await expect(provider.authorizeDeposit({ paymentId: 'p1', providerReference: '', amount: 500, currency: 'ZAR' })).rejects.toThrow(NotImplementedError)
    await expect(provider.captureDeposit({ paymentId: 'p1', providerReference: '', amount: 500, currency: 'ZAR' })).rejects.toThrow(NotImplementedError)
    await expect(provider.releaseDeposit({ paymentId: 'p1', providerReference: '', amount: 500, currency: 'ZAR' })).rejects.toThrow(NotImplementedError)
    await expect(provider.chargeRental({ paymentId: 'p1', providerReference: '', amount: 500, currency: 'ZAR' })).rejects.toThrow(NotImplementedError)
    await expect(provider.refund({ paymentId: 'p1', providerReference: '', amount: 500, currency: 'ZAR' })).rejects.toThrow(NotImplementedError)
    await expect(provider.createMerchantPayout({ merchantId: 'm1', amount: 500, currency: 'ZAR' })).rejects.toThrow(NotImplementedError)
  })

  // verifyWebhook() and healthCheck() are real, not stubbed -- neither moves
  // money nor calls a live API (pure crypto / config inspection), so Phase
  // 2D implements them for real. See src/lib/payments/providers/peach/__tests__.
})

describe('payment provider registry', () => {
  it('registers both mock and peach', () => {
    expect(listRegisteredProviders().sort()).toEqual(['mock', 'peach'])
  })

  it('defaults to the mock provider when none is specified and no env override is set', () => {
    expect(getPaymentProvider().name).toBe('mock')
  })

  it('returns the requested provider by name', () => {
    expect(getPaymentProvider('peach').name).toBe('peach')
    expect(getPaymentProvider('mock').name).toBe('mock')
  })

  it('throws for an unknown provider name rather than silently falling back', () => {
    expect(() => getPaymentProvider('stripe')).toThrow(/Unknown payment provider/)
  })
})
