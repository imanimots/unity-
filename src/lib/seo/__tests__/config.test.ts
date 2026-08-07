import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  isIndexingEnabled,
  isMarketplaceIndexingEnabled,
  getDefaultRobotsMeta,
  getMarketplaceRobotsMeta,
  getAppUrl,
  absoluteUrl,
  PERMANENT_NOINDEX,
} from '../config'

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe('SEO config — safe defaults (category: Indexation Gate)', () => {
  beforeEach(() => {
    delete process.env.SEO_INDEXING_ENABLED
    delete process.env.SEO_MARKETPLACE_INDEXING_ENABLED
  })

  it('1. isIndexingEnabled defaults to false when unset', () => {
    expect(isIndexingEnabled()).toBe(false)
  })

  it('2. isMarketplaceIndexingEnabled defaults to false when unset', () => {
    expect(isMarketplaceIndexingEnabled()).toBe(false)
  })

  it('3. getDefaultRobotsMeta is noindex,nofollow when the flag is unset', () => {
    expect(getDefaultRobotsMeta()).toEqual(PERMANENT_NOINDEX)
  })

  it('4. getMarketplaceRobotsMeta is noindex,nofollow when its flag is unset, even if the general flag is on', () => {
    process.env.SEO_INDEXING_ENABLED = 'true'
    expect(getMarketplaceRobotsMeta()).toEqual(PERMANENT_NOINDEX)
  })

  it('5. only the exact string "true" enables a flag — any other value stays safe/false', () => {
    process.env.SEO_INDEXING_ENABLED = 'TRUE'
    expect(isIndexingEnabled()).toBe(false)
    process.env.SEO_INDEXING_ENABLED = '1'
    expect(isIndexingEnabled()).toBe(false)
  })

  it('6. flipping SEO_INDEXING_ENABLED=true does not also enable marketplace indexing', () => {
    process.env.SEO_INDEXING_ENABLED = 'true'
    expect(isIndexingEnabled()).toBe(true)
    expect(isMarketplaceIndexingEnabled()).toBe(false)
  })

  it('7. both flags true independently enable both robots meta helpers', () => {
    process.env.SEO_INDEXING_ENABLED = 'true'
    process.env.SEO_MARKETPLACE_INDEXING_ENABLED = 'true'
    expect(getDefaultRobotsMeta()).toEqual({ index: true, follow: true })
    expect(getMarketplaceRobotsMeta()).toEqual({ index: true, follow: true })
  })
})

describe('getAppUrl / absoluteUrl — never hardcodes a future permanent domain (category: Metadata Hygiene)', () => {
  it('8. uses NEXT_PUBLIC_APP_URL when set, with no trailing slash', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://public-test.example.com/'
    expect(getAppUrl()).toBe('https://public-test.example.com')
  })

  it('9. falls back to localhost only when unset', () => {
    delete process.env.NEXT_PUBLIC_APP_URL
    expect(getAppUrl()).toBe('http://localhost:3000')
  })

  it('10. absoluteUrl joins the configured app URL with a relative path', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://public-test.example.com'
    expect(absoluteUrl('/listings')).toBe('https://public-test.example.com/listings')
    expect(absoluteUrl('listings')).toBe('https://public-test.example.com/listings')
  })
})
