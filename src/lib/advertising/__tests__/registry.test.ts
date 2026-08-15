import { describe, it, expect, afterEach } from 'vitest'
import { getAdvertisingBillingProvider, listRegisteredAdvertisingBillingProviders } from '../registry'

/** process.env.NODE_ENV is typed read-only by @types/node -- mutate it directly here to prove the guard against the real runtime check it reads. */
const mutableEnv = process.env as Record<string, string | undefined>

describe('getAdvertisingBillingProvider() production safety guard', () => {
  const originalNodeEnv = process.env.NODE_ENV
  const originalProvider = process.env.ADVERTISING_BILLING_PROVIDER

  afterEach(() => {
    if (originalNodeEnv === undefined) delete mutableEnv.NODE_ENV
    else mutableEnv.NODE_ENV = originalNodeEnv
    if (originalProvider === undefined) delete mutableEnv.ADVERTISING_BILLING_PROVIDER
    else mutableEnv.ADVERTISING_BILLING_PROVIDER = originalProvider
  })

  it('production + mock (via env default) throws -- a fake balance can never become production financial authority', () => {
    mutableEnv.NODE_ENV = 'production'
    delete mutableEnv.ADVERTISING_BILLING_PROVIDER
    expect(() => getAdvertisingBillingProvider()).toThrow(/production/)
  })

  it('production + mock (explicitly named) throws -- a client/route-supplied provider name cannot bypass the guard', () => {
    mutableEnv.NODE_ENV = 'production'
    expect(() => getAdvertisingBillingProvider('mock')).toThrow(/production/)
  })

  it('development + mock works normally', () => {
    mutableEnv.NODE_ENV = 'development'
    mutableEnv.ADVERTISING_BILLING_PROVIDER = 'mock'
    expect(getAdvertisingBillingProvider()).toBeTruthy()
  })

  it('test environment + mock works normally (this test suite itself depends on it)', () => {
    mutableEnv.NODE_ENV = 'test'
    mutableEnv.ADVERTISING_BILLING_PROVIDER = 'mock'
    expect(getAdvertisingBillingProvider()).toBeTruthy()
  })

  it('an unknown provider name throws its own "unknown provider" error, not the configuration guard', () => {
    mutableEnv.NODE_ENV = 'production'
    expect(() => getAdvertisingBillingProvider('stripe')).toThrow(/Unknown advertising billing provider/)
  })
})

describe('advertising billing provider registry', () => {
  it('registers exactly the mock provider for this MVP', () => {
    expect(listRegisteredAdvertisingBillingProviders()).toEqual(['mock'])
  })

  it('defaults to the mock provider when none is specified and no env override is set (outside production)', () => {
    mutableEnv.NODE_ENV = 'test'
    delete mutableEnv.ADVERTISING_BILLING_PROVIDER
    expect(getAdvertisingBillingProvider()).toBeTruthy()
  })
})
