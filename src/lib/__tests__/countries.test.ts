import { describe, it, expect } from 'vitest'
import { isSupportedCountry, getCountry, DEFAULT_COUNTRY, COUNTRIES } from '../countries'

describe('isSupportedCountry', () => {
  it('accepts the one active country', () => {
    expect(isSupportedCountry('ZA')).toBe(true)
  })

  it('rejects a known-but-inactive ("coming soon") country', () => {
    expect(isSupportedCountry('NG')).toBe(false)
    expect(isSupportedCountry('KE')).toBe(false)
    expect(isSupportedCountry('GH')).toBe(false)
    expect(isSupportedCountry('GB')).toBe(false)
  })

  it('rejects an unknown code', () => {
    expect(isSupportedCountry('XX')).toBe(false)
  })

  it('rejects null, undefined, and empty string', () => {
    expect(isSupportedCountry(null)).toBe(false)
    expect(isSupportedCountry(undefined)).toBe(false)
    expect(isSupportedCountry('')).toBe(false)
  })
})

describe('getCountry', () => {
  it('resolves a known code', () => {
    expect(getCountry('ZA').name).toBe('South Africa')
  })

  it('falls back to DEFAULT_COUNTRY for an unknown code', () => {
    expect(getCountry('XX')).toBe(DEFAULT_COUNTRY)
  })

  it('every seeded country has a unique id', () => {
    const ids = COUNTRIES.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
