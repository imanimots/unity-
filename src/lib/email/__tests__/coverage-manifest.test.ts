import { describe, it, expect } from 'vitest'
import { getEmailCoverageManifest, summarizeEmailCoverage } from '../coverage-manifest'
import { EMAIL_TEMPLATES } from '../templates/catalogue'

describe('email coverage manifest', () => {
  it('1. manifest enumerates every real catalogue template (no drift)', () => {
    const manifest = getEmailCoverageManifest()
    expect(manifest.length).toBe(EMAIL_TEMPLATES.length)
    expect(manifest.map((m) => m.id).sort()).toEqual(EMAIL_TEMPLATES.map((t) => t.id).sort())
  })

  it('2. en-ZA is always complete for every template (the required, unconditional default)', () => {
    for (const entry of getEmailCoverageManifest()) {
      expect(entry.localeComplete['en-ZA']).toBe(true)
    }
  })

  it('3. a template is only reported complete if it actually has real localeVariants for af-ZA/zu-ZA', () => {
    const def = EMAIL_TEMPLATES.find((t) => t.id === 'booking-requested-renter')
    expect(def?.localeVariants?.['af-ZA']).toBeDefined()
    expect(def?.localeVariants?.['zu-ZA']).toBeDefined()
    const entry = getEmailCoverageManifest().find((m) => m.id === 'booking-requested-renter')
    expect(entry?.fullyComplete).toBe(true)
  })

  it('4. summary counts are internally consistent', () => {
    const summary = summarizeEmailCoverage()
    expect(summary.totalTemplates).toBe(summary.customerMerchantCount + summary.staffOnlyCount)
    expect(summary.fullyCompleteCount).toBeLessThanOrEqual(summary.customerMerchantCount)
    expect(summary.incompleteIds.length).toBe(summary.customerMerchantCount - summary.fullyCompleteCount)
  })

  it('5. current real coverage: 91 total templates, 0 staff-only, 91 fully complete -- full en-ZA/af-ZA/zu-ZA coverage (documented ground truth -- update this test when coverage genuinely changes, not to make it pass)', () => {
    const summary = summarizeEmailCoverage()
    expect(summary.totalTemplates).toBe(91)
    expect(summary.staffOnlyCount).toBe(0)
    expect(summary.fullyCompleteCount).toBe(91)
    expect(summary.incompleteIds).toEqual([])
    expect(summary.perLocale).toEqual({ 'en-ZA': 91, 'af-ZA': 91, 'zu-ZA': 91 })
  })
})
