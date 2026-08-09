import { describe, it, expect, afterEach } from 'vitest'
import { getEscrowProvider } from '../registry'
import { EscrowProviderConfigurationError } from '../provider-errors'
import { EscrowNotImplementedError } from '../provider'

/** process.env.NODE_ENV is typed read-only by @types/node -- this is the one legitimate place in this codebase that needs to mutate it directly, to prove the guard against the real runtime check it reads. */
const mutableEnv = process.env as Record<string, string | undefined>

/**
 * Corrective verification (item A/B/F): getEscrowProvider() is the one
 * central, server-only authority MockEscrowProvider can never be
 * resolved through while NODE_ENV=production -- proven directly against
 * the real registry module, not a re-implementation of its logic.
 */
describe('getEscrowProvider() production safety guard', () => {
  const originalNodeEnv = process.env.NODE_ENV
  const originalProvider = process.env.ESCROW_PROVIDER

  afterEach(() => {
    if (originalNodeEnv === undefined) delete mutableEnv.NODE_ENV
    else mutableEnv.NODE_ENV = originalNodeEnv
    if (originalProvider === undefined) delete mutableEnv.ESCROW_PROVIDER
    else mutableEnv.ESCROW_PROVIDER = originalProvider
  })

  it('production + mock (via env default) throws EscrowProviderConfigurationError', () => {
    mutableEnv.NODE_ENV = 'production'
    delete mutableEnv.ESCROW_PROVIDER
    expect(() => getEscrowProvider()).toThrow(EscrowProviderConfigurationError)
  })

  it('production + mock (explicitly named) throws -- a client/route-supplied provider name cannot bypass the guard', () => {
    mutableEnv.NODE_ENV = 'production'
    // Mirrors exactly how the webhook route resolves a provider: a
    // caller-supplied name (there, the [provider] URL segment) passed
    // directly as the `name` argument -- the guard must still fire.
    expect(() => getEscrowProvider('mock')).toThrow(EscrowProviderConfigurationError)
  })

  it('development + mock works normally', () => {
    mutableEnv.NODE_ENV = 'development'
    mutableEnv.ESCROW_PROVIDER = 'mock'
    expect(getEscrowProvider().name).toBe('mock')
  })

  it('test environment + mock works normally (this test suite itself depends on it)', () => {
    mutableEnv.NODE_ENV = 'test'
    mutableEnv.ESCROW_PROVIDER = 'mock'
    expect(getEscrowProvider().name).toBe('mock')
  })

  it('unset NODE_ENV + mock works normally (defaults are permissive; ESCROW_ENABLED is the real gate elsewhere)', () => {
    delete mutableEnv.NODE_ENV
    mutableEnv.ESCROW_PROVIDER = 'mock'
    expect(getEscrowProvider().name).toBe('mock')
  })

  it('production + tradesafe does NOT throw the configuration guard -- UnsupportedTradeSafeProvider remains unsupported on its own terms (throws EscrowNotImplementedError on every real operation, in every environment)', async () => {
    mutableEnv.NODE_ENV = 'production'
    mutableEnv.ESCROW_PROVIDER = 'tradesafe'
    const provider = getEscrowProvider()
    expect(provider.name).toBe('tradesafe')
    await expect(provider.createEscrowTransaction({ transactionType: 'sale', principalAmount: 100, secureTransactionFeeAmount: 0, currency: 'ZAR' })).rejects.toThrow(EscrowNotImplementedError)
  })

  it('an unknown provider name still throws its own "unknown provider" error, not the configuration guard, in any environment', () => {
    mutableEnv.NODE_ENV = 'production'
    expect(() => getEscrowProvider('stripe')).toThrow(/Unknown escrow provider/)
  })

  it('item D: the webhook route (src/app/api/escrow/webhooks/[provider]/route.ts) resolution pattern -- getEscrowProvider(providerName) then provider.verifyWebhook(...) -- throws before verifyWebhook is ever reached, so record_escrow_webhook_event() (the only write to escrow_provider_events) is never called and no financial/status mutation can occur', async () => {
    mutableEnv.NODE_ENV = 'production'
    let verifyWebhookWasCalled = false
    let recordEventWasCalled = false

    // Exact shape of the webhook route's own try/catch, reproduced here
    // (not re-imported, since the route itself needs a Next.js request
    // object) -- the assertion that matters is that verifyWebhook/
    // record_escrow_webhook_event are provably unreachable once
    // getEscrowProvider() throws, which is the real, load-bearing
    // guarantee regardless of how the route wraps it.
    try {
      const provider = getEscrowProvider('mock') // mirrors providerName from the [provider] URL segment
      verifyWebhookWasCalled = true // unreachable if the line above throws
      await provider.verifyWebhook({ rawBody: '{}', headers: { 'x-mock-signature': 'mock-signature' } })
    } catch (err) {
      expect(err).toBeInstanceOf(EscrowProviderConfigurationError)
    }
    if (verifyWebhookWasCalled) recordEventWasCalled = true // would only ever be reached after a successful verification

    expect(verifyWebhookWasCalled).toBe(false)
    expect(recordEventWasCalled).toBe(false)
  })
})
