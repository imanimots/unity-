import { describe, it, expect } from 'vitest'
import { LEGAL_DOCUMENTS, getLegalDocument, resolvePolicyVersions } from '../registry'

const REQUIRED_SLUGS = [
  'terms',
  'privacy',
  'popia',
  'rental-terms',
  'payments-and-deposits',
  'cancellations',
  'refunds',
  'disputes',
  'prohibited-items',
  'delivery-and-handover',
  'verification-and-trust',
  'contact',
]

describe('LEGAL_DOCUMENTS registry (category: Content)', () => {
  it('1. every required route has a registry entry', () => {
    for (const slug of REQUIRED_SLUGS) {
      expect(getLegalDocument(slug), `missing registry entry for "${slug}"`).toBeDefined()
    }
  })

  it('2. every entry has a version, effective date, and last-updated date', () => {
    for (const doc of LEGAL_DOCUMENTS) {
      expect(doc.version.length, doc.slug).toBeGreaterThan(0)
      expect(doc.effectiveDate.length, doc.slug).toBeGreaterThan(0)
      expect(doc.lastUpdated.length, doc.slug).toBeGreaterThan(0)
    }
  })

  it('3. every entry is marked draft -- no Legalese-approved source exists anywhere in this repository', () => {
    for (const doc of LEGAL_DOCUMENTS) {
      expect(doc.status, doc.slug).toBe('draft')
      expect(doc.source, doc.slug).toBe('internal_draft')
    }
  })

  it('4. every entry\'s route matches slug convention (/<slug>)', () => {
    for (const doc of LEGAL_DOCUMENTS) {
      expect(doc.route).toBe(`/${doc.slug}`)
    }
  })

  it('5. no duplicate slugs', () => {
    const slugs = LEGAL_DOCUMENTS.map((d) => d.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
  })
})

describe('resolvePolicyVersions (category: Consent)', () => {
  it('6. resolves known slugs to their current registry version', () => {
    const result = resolvePolicyVersions(['terms', 'privacy'])
    expect(result).toEqual([
      { slug: 'terms', version: getLegalDocument('terms')!.version },
      { slug: 'privacy', version: getLegalDocument('privacy')!.version },
    ])
  })

  it('7. silently drops unknown slugs rather than inventing a version for them', () => {
    const result = resolvePolicyVersions(['terms', 'not-a-real-policy'])
    expect(result).toEqual([{ slug: 'terms', version: getLegalDocument('terms')!.version }])
  })

  it('8. returns an empty array for an all-unknown input, never throwing', () => {
    expect(resolvePolicyVersions(['bogus-1', 'bogus-2'])).toEqual([])
  })

  it('9. never accepts a caller-supplied version -- the function signature only takes slugs', () => {
    // Type-level guarantee: resolvePolicyVersions(slugs: string[]) has no
    // version parameter at all, so a caller cannot pass one even by
    // mistake. This test documents that guarantee for future readers.
    expect(resolvePolicyVersions.length).toBe(1)
  })
})
