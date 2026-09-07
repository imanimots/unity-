import { describe, it, expect } from 'vitest'
import { resolveAdsAvailability, coerceAdsAvailability } from '../availability'

describe('coerceAdsAvailability (category: Fail-Closed Defaults)', () => {
  it('1. true stays available', () => {
    expect(coerceAdsAvailability(true)).toBe(true)
  })
  it('2. false resolves to unavailable', () => {
    expect(coerceAdsAvailability(false)).toBe(false)
  })
  it('3. missing/undefined resolves to unavailable (a fetch failure passes undefined)', () => {
    expect(coerceAdsAvailability(undefined)).toBe(false)
  })
  it('4. null resolves to unavailable', () => {
    expect(coerceAdsAvailability(null)).toBe(false)
  })
  it('5. a malformed/truthy-but-non-boolean value resolves to unavailable (never loosely truthy)', () => {
    expect(coerceAdsAvailability('true')).toBe(false)
    expect(coerceAdsAvailability(1)).toBe(false)
    expect(coerceAdsAvailability({})).toBe(false)
  })
})

describe('resolveAdsAvailability (category: Ads Creation Surface State)', () => {
  it('6. loading takes priority over availability', () => {
    expect(resolveAdsAvailability(true, true)).toBe('loading')
    expect(resolveAdsAvailability(true, false)).toBe('loading')
  })
  it('7. CASE 1 -- advertising OFF (not loading, not available) -> unavailable', () => {
    expect(resolveAdsAvailability(false, false)).toBe('unavailable')
  })
  it('8. CASE 2 -- advertising ON (not loading, available) -> ready', () => {
    expect(resolveAdsAvailability(false, true)).toBe('ready')
  })
})
