import { describe, it, expect, afterEach } from 'vitest'
import { resolveProfileRobots } from '../seo'

describe('resolveProfileRobots', () => {
  const original = process.env.SEO_MARKETPLACE_INDEXING_ENABLED

  afterEach(() => {
    process.env.SEO_MARKETPLACE_INDEXING_ENABLED = original
  })

  it('is always noindex for a not_found profile, regardless of the flag', () => {
    process.env.SEO_MARKETPLACE_INDEXING_ENABLED = 'true'
    expect(resolveProfileRobots('not_found')).toEqual({ index: false, follow: false })
  })

  it('is always noindex for an unavailable (suspended) profile, regardless of the flag', () => {
    process.env.SEO_MARKETPLACE_INDEXING_ENABLED = 'true'
    expect(resolveProfileRobots('unavailable')).toEqual({ index: false, follow: false })
  })

  it('is noindex for an ok profile when the marketplace indexing flag is off (current pre-launch state)', () => {
    process.env.SEO_MARKETPLACE_INDEXING_ENABLED = 'false'
    expect(resolveProfileRobots('ok')).toEqual({ index: false, follow: false })
  })

  it('is noindex for an ok profile when the flag is unset', () => {
    delete process.env.SEO_MARKETPLACE_INDEXING_ENABLED
    expect(resolveProfileRobots('ok')).toEqual({ index: false, follow: false })
  })

  it('would only become indexable for an ok profile once the existing marketplace gate is explicitly enabled', () => {
    process.env.SEO_MARKETPLACE_INDEXING_ENABLED = 'true'
    expect(resolveProfileRobots('ok')).toEqual({ index: true, follow: true })
  })
})
