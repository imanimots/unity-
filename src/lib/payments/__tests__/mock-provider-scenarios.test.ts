import { describe, it, expect } from 'vitest'
import { MockProvider } from '../providers/mock-provider'
import { ProviderTimeoutError, RetryableProviderError, TerminalProviderError } from '../provider-errors'

describe('MockProvider deterministic scenarios (never randomness)', () => {
  const provider = new MockProvider()

  it('defaults to success when mockScenario is omitted', async () => {
    const result = await provider.chargeRental({ paymentId: 'p1', providerReference: '', amount: 1000, currency: 'ZAR' })
    expect(result.status).toBe('captured')
  })

  it('"declined" returns a failed result, not a thrown error -- a decline is a valid provider response', async () => {
    const result = await provider.chargeRental({ paymentId: 'p1', providerReference: '', amount: 1000, currency: 'ZAR', mockScenario: 'declined' })
    expect(result.status).toBe('failed')
    expect(result.failureReason).toBeTruthy()
  })

  it('"timeout" throws ProviderTimeoutError', async () => {
    await expect(
      provider.chargeRental({ paymentId: 'p1', providerReference: '', amount: 1000, currency: 'ZAR', mockScenario: 'timeout' })
    ).rejects.toBeInstanceOf(ProviderTimeoutError)
  })

  it('"retryable_failure" throws RetryableProviderError', async () => {
    await expect(
      provider.authorizeDeposit({ paymentId: 'p1', providerReference: '', amount: 500, currency: 'ZAR', mockScenario: 'retryable_failure' })
    ).rejects.toBeInstanceOf(RetryableProviderError)
  })

  it('"terminal_failure" throws TerminalProviderError', async () => {
    await expect(
      provider.authorizeDeposit({ paymentId: 'p1', providerReference: '', amount: 500, currency: 'ZAR', mockScenario: 'terminal_failure' })
    ).rejects.toBeInstanceOf(TerminalProviderError)
  })

  it('"duplicate" returns a fixed, repeatable reference rather than a fresh random one', async () => {
    const first = await provider.chargeRental({ paymentId: 'p1', providerReference: '', amount: 1000, currency: 'ZAR', mockScenario: 'duplicate' })
    const second = await provider.chargeRental({ paymentId: 'p2', providerReference: '', amount: 1000, currency: 'ZAR', mockScenario: 'duplicate' })
    expect(first.providerReference).toBe(second.providerReference)
  })

  it('every scenario is deterministic across repeated calls (no randomness)', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => provider.authorizeDeposit({ paymentId: 'p1', providerReference: '', amount: 500, currency: 'ZAR', mockScenario: 'declined' }))
    )
    for (const r of results) {
      expect(r.status).toBe('failed')
      expect(r.failureReason).toBe(results[0].failureReason)
    }
  })

  it('captureDeposit supports a partial amount being passed through to the result unaffected by scenario selection', async () => {
    const result = await provider.captureDeposit({ paymentId: 'p1', providerReference: 'ref-1', amount: 150, currency: 'ZAR' })
    expect(result.status).toBe('captured')
    expect(result.providerReference).toBe('ref-1')
  })
})
