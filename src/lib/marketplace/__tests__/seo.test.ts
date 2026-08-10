import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { PERMANENT_NOINDEX } from '@/lib/seo/config'
import { isMarketplaceRequestPubliclyActive, resolveLookingForRequestRobots } from '../seo'

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe('marketplace request SEO robots (category: Looking For Indexation)', () => {
  beforeEach(() => {
    delete process.env.SEO_INDEXING_ENABLED
    delete process.env.SEO_MARKETPLACE_INDEXING_ENABLED
  })

  it('1. global marketplace indexing disabled + active public request -> noindex', () => {
    expect(resolveLookingForRequestRobots('active', false)).toEqual(PERMANENT_NOINDEX)
  })

  it('1b. global marketplace indexing disabled + offers_received public request -> noindex', () => {
    expect(resolveLookingForRequestRobots('offers_received', false)).toEqual(PERMANENT_NOINDEX)
  })

  it('2. marketplace indexing gate enabled + eligible active public request -> not permanently forced noindex', () => {
    process.env.SEO_MARKETPLACE_INDEXING_ENABLED = 'true'
    expect(resolveLookingForRequestRobots('active', false)).toEqual({ index: true, follow: true })
  })

  it('2b. the general SEO_INDEXING_ENABLED flag alone (not the marketplace-specific one) never enables it', () => {
    process.env.SEO_INDEXING_ENABLED = 'true'
    expect(resolveLookingForRequestRobots('active', false)).toEqual(PERMANENT_NOINDEX)
  })

  it('3. a draft request is noindex regardless of the marketplace gate', () => {
    process.env.SEO_MARKETPLACE_INDEXING_ENABLED = 'true'
    expect(resolveLookingForRequestRobots('draft', false)).toEqual(PERMANENT_NOINDEX)
  })

  it('4. an archived/closed/date_passed/matched/completed request is noindex regardless of the marketplace gate', () => {
    process.env.SEO_MARKETPLACE_INDEXING_ENABLED = 'true'
    for (const status of ['archived', 'closed', 'date_passed', 'matched', 'completed']) {
      expect(resolveLookingForRequestRobots(status, false), status).toEqual(PERMANENT_NOINDEX)
    }
  })

  it('5. an is_test fixture is always noindex regardless of status or the marketplace gate', () => {
    process.env.SEO_MARKETPLACE_INDEXING_ENABLED = 'true'
    expect(resolveLookingForRequestRobots('active', true)).toEqual(PERMANENT_NOINDEX)
    expect(resolveLookingForRequestRobots('offers_received', true)).toEqual(PERMANENT_NOINDEX)
  })

  it('6. isMarketplaceRequestPubliclyActive matches the exact status set the public browse feed itself surfaces', () => {
    expect(isMarketplaceRequestPubliclyActive('active', false)).toBe(true)
    expect(isMarketplaceRequestPubliclyActive('offers_received', false)).toBe(true)
    expect(isMarketplaceRequestPubliclyActive('draft', false)).toBe(false)
    expect(isMarketplaceRequestPubliclyActive('matched', false)).toBe(false)
    expect(isMarketplaceRequestPubliclyActive('active', true)).toBe(false)
  })
})
