import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getActivePaymentProvider, isMockPaymentAuthorityAllowed, assertProviderSupportsCapability, ProviderNotPermittedError } from '../registry'
import { ProviderCapabilityUnsupportedError } from '../provider'

/**
 * E30: production previously resolved an unspecified PAYMENT_PROVIDER to
 * MockProvider silently (`name || process.env.PAYMENT_PROVIDER ||
 * 'mock'`). These tests prove the new environment classifier and the
 * active-provider gate close all three paths the brief named: an unset
 * env var, an explicit PAYMENT_PROVIDER=mock, and an explicit
 * providerName='mock' argument -- all three resolve to the identical
 * key 'mock' by the time isMockPaymentAuthorityAllowed() is consulted.
 *
 * vi.stubEnv/unstubAllEnvs (not direct process.env assignment) matches
 * this codebase's own established convention for exactly this kind of
 * test -- see src/lib/checkout/__tests__/test-scenario.test.ts.
 */
beforeEach(() => {
  vi.unstubAllEnvs()
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('isMockPaymentAuthorityAllowed -- environment classification matrix', () => {
  it('NODE_ENV=test always allows mock, regardless of VERCEL_ENV', () => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('VERCEL_ENV', 'production')
    expect(isMockPaymentAuthorityAllowed()).toBe(true)
  })

  it('VERCEL_ENV=production forbids mock, regardless of NODE_ENV', () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('VERCEL_ENV', 'production')
    expect(isMockPaymentAuthorityAllowed()).toBe(false)
  })

  it('VERCEL_ENV=preview allows mock even when NODE_ENV=production (Next.js sets this during a Preview build)', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('VERCEL_ENV', 'preview')
    expect(isMockPaymentAuthorityAllowed()).toBe(true)
  })

  it('VERCEL_ENV=development allows mock', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('VERCEL_ENV', 'development')
    expect(isMockPaymentAuthorityAllowed()).toBe(true)
  })

  it('no VERCEL_ENV at all, NODE_ENV=production (a non-Vercel production host) fails closed', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('VERCEL_ENV', undefined)
    expect(isMockPaymentAuthorityAllowed()).toBe(false)
  })

  it('no VERCEL_ENV, NODE_ENV=development (local dev) allows mock', () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('VERCEL_ENV', undefined)
    expect(isMockPaymentAuthorityAllowed()).toBe(true)
  })
})

describe('getActivePaymentProvider -- all 3 named production-mock paths reject identically', () => {
  it('production + PAYMENT_PROVIDER absent (the implicit-fallback path) rejects with ProviderNotPermittedError, never silently returning MockProvider', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('VERCEL_ENV', 'production')
    vi.stubEnv('PAYMENT_PROVIDER', undefined)
    expect(() => getActivePaymentProvider()).toThrow(ProviderNotPermittedError)
  })

  it('production + PAYMENT_PROVIDER=mock (the explicit-env-var path) rejects', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('VERCEL_ENV', 'production')
    vi.stubEnv('PAYMENT_PROVIDER', 'mock')
    expect(() => getActivePaymentProvider()).toThrow(ProviderNotPermittedError)
  })

  it('production + an explicit providerName="mock" argument (the explicit-call-site path) rejects', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('VERCEL_ENV', 'production')
    vi.stubEnv('PAYMENT_PROVIDER', undefined)
    expect(() => getActivePaymentProvider('mock')).toThrow(ProviderNotPermittedError)
  })

  it('production + PAYMENT_PROVIDER=peach rejects because Peach is retained only as a legacy provider', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('VERCEL_ENV', 'production')
    vi.stubEnv('PAYMENT_PROVIDER', 'peach')
    expect(() => getActivePaymentProvider()).toThrow(ProviderNotPermittedError)
  })

  it('preview + PAYMENT_PROVIDER absent still returns MockProvider', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('VERCEL_ENV', 'preview')
    vi.stubEnv('PAYMENT_PROVIDER', undefined)
    expect(getActivePaymentProvider().name).toBe('mock')
  })

  it('test environment + PAYMENT_PROVIDER absent still returns MockProvider', () => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('VERCEL_ENV', undefined)
    vi.stubEnv('PAYMENT_PROVIDER', undefined)
    expect(getActivePaymentProvider().name).toBe('mock')
  })

  it('an unknown provider name still throws the original "Unknown payment provider" error, not ProviderNotPermittedError', () => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('VERCEL_ENV', undefined)
    vi.stubEnv('PAYMENT_PROVIDER', undefined)
    expect(() => getActivePaymentProvider('stripe')).toThrow(/Unknown payment provider/)
  })
})

describe('assertProviderSupportsCapability', () => {
  it('passes silently when the provider reports support', () => {
    const provider = { name: 'mock', supportsCapability: () => true } as never
    expect(() => assertProviderSupportsCapability(provider, 'refund')).not.toThrow()
  })

  it('throws ProviderCapabilityUnsupportedError, naming the provider and capability, when unsupported', () => {
    const provider = { name: 'peach', supportsCapability: () => false } as never
    expect(() => assertProviderSupportsCapability(provider, 'refund')).toThrow(ProviderCapabilityUnsupportedError)
    expect(() => assertProviderSupportsCapability(provider, 'refund')).toThrow(/peach.*refund/)
  })
})
