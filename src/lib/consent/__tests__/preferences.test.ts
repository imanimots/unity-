import { describe, it, expect, vi, afterEach } from 'vitest'
import { readConsentPreferences, writeConsentPreferences, hasAnalyticsConsent, hasMarketingConsent, hasDecidedConsent, CONSENT_VERSION } from '../preferences'

function makeFakeLocalStorage(seed?: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(seed ?? {}))
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
  }
}

describe('consent preferences (category: Platform Improvement Programme Phase 3)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('1. readConsentPreferences returns null when nothing is stored -- no decision, not an implicit opt-in', () => {
    vi.stubGlobal('window', { localStorage: makeFakeLocalStorage() })
    expect(readConsentPreferences()).toBeNull()
    expect(hasAnalyticsConsent()).toBe(false)
    expect(hasMarketingConsent()).toBe(false)
    expect(hasDecidedConsent()).toBe(false)
  })

  it('2. writeConsentPreferences persists the choice and readConsentPreferences reflects it exactly', () => {
    vi.stubGlobal('window', { localStorage: makeFakeLocalStorage(), dispatchEvent: vi.fn() })
    writeConsentPreferences({ analytics: true, marketing: false })
    const read = readConsentPreferences()
    expect(read?.analytics).toBe(true)
    expect(read?.marketing).toBe(false)
    expect(read?.essential).toBe(true)
    expect(read?.version).toBe(CONSENT_VERSION)
    expect(hasAnalyticsConsent()).toBe(true)
    expect(hasDecidedConsent()).toBe(true)
  })

  it('3. declining analytics is a real recorded decision, not indistinguishable from "no decision yet"', () => {
    vi.stubGlobal('window', { localStorage: makeFakeLocalStorage(), dispatchEvent: vi.fn() })
    writeConsentPreferences({ analytics: false, marketing: false })
    expect(hasDecidedConsent()).toBe(true)
    expect(hasAnalyticsConsent()).toBe(false)
  })

  it('4. a stored record with the wrong version is treated as no decision (schema migration safety)', () => {
    vi.stubGlobal('window', {
      localStorage: makeFakeLocalStorage({
        unity_consent_preferences_v1: JSON.stringify({ analytics: true, marketing: true, version: 999, decidedAt: '2026-01-01T00:00:00.000Z' }),
      }),
    })
    expect(readConsentPreferences()).toBeNull()
    expect(hasAnalyticsConsent()).toBe(false)
  })

  it('5. malformed JSON in storage never throws, resolves to no decision', () => {
    vi.stubGlobal('window', { localStorage: makeFakeLocalStorage({ unity_consent_preferences_v1: '{not json' }) })
    expect(() => readConsentPreferences()).not.toThrow()
    expect(readConsentPreferences()).toBeNull()
  })

  it('6. writeConsentPreferences never throws even if localStorage.setItem throws (private browsing / quota)', () => {
    vi.stubGlobal('window', {
      localStorage: { getItem: () => null, setItem: () => { throw new Error('quota exceeded') } },
      dispatchEvent: vi.fn(),
    })
    expect(() => writeConsentPreferences({ analytics: true, marketing: false })).not.toThrow()
  })

  it('7. SSR safety -- every function is a safe no-op/false when window is undefined', () => {
    vi.stubGlobal('window', undefined)
    expect(readConsentPreferences()).toBeNull()
    expect(hasAnalyticsConsent()).toBe(false)
    expect(hasMarketingConsent()).toBe(false)
    expect(hasDecidedConsent()).toBe(false)
    expect(() => writeConsentPreferences({ analytics: true, marketing: true })).not.toThrow()
  })

  it('8. marketing consent can be granted independently of analytics -- one never implies the other', () => {
    vi.stubGlobal('window', { localStorage: makeFakeLocalStorage(), dispatchEvent: vi.fn() })
    writeConsentPreferences({ analytics: false, marketing: true })
    expect(hasAnalyticsConsent()).toBe(false)
    expect(hasMarketingConsent()).toBe(true)
  })
})
