import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// DB-free structural guard -- same convention as the migration-source
// tests elsewhere in this codebase. No jsdom/component-render
// infrastructure exists in this repo (vitest runs in the `node`
// environment only), so Admin Server Component pages are verified by
// source inspection rather than a full render -- this proves the one
// property that matters here: the homepage summary card and
// /admin/intelligence consume the EXACT SAME service function, never a
// second, parallel implementation of the recommendation logic.
const REPO_ROOT = join(__dirname, '../../../..')

describe('Admin homepage Intelligence card wiring (category: ADMIN-CONTROL-CENTRE-BATCH-E1)', () => {
  const homepage = readFileSync(join(REPO_ROOT, 'src/app/admin/page.tsx'), 'utf-8')
  const intelligencePage = readFileSync(join(REPO_ROOT, 'src/app/admin/intelligence/page.tsx'), 'utf-8')

  it('1. both the homepage and /admin/intelligence import getIntelligenceInsights from the same service module -- no duplicated recommendation logic', () => {
    expect(homepage).toMatch(/import\s*\{[^}]*\bgetIntelligenceInsights\b[^}]*\}\s*from\s*'@\/lib\/admin\/intelligence-service'/)
    expect(intelligencePage).toMatch(/getIntelligenceInsights[^}]*\}\s*from\s*'@\/lib\/admin\/intelligence-service'/)
  })

  it('2. the homepage card reads only from the shared summary object (realData/operational/dataQualityLimitations), never recomputing or filtering the insight list itself', () => {
    expect(homepage).toMatch(/intelligence\.summary\.realData\.highPriority/)
    expect(homepage).toMatch(/intelligence\.summary\.realData\.opportunities/)
    expect(homepage).toMatch(/intelligence\.summary\.operational\.highPriority/)
    expect(homepage).toMatch(/intelligence\.summary\.dataQualityLimitations/)
    // The homepage never maps/filters the raw insights array -- it must not duplicate the page's own rendering of individual insight cards.
    expect(homepage).not.toMatch(/intelligence\.insights\.(map|filter)/)
  })

  it('2b. the homepage card visibly distinguishes Real Data from Operational (all-system) counts, rather than one scope-blind total', () => {
    expect(homepage).toMatch(/Real Data/)
    expect(homepage).toMatch(/Operational \(all-system\)/)
  })

  it('3. the homepage card links to /admin/intelligence rather than rendering full insight cards inline', () => {
    expect(homepage).toMatch(/href="\/admin\/intelligence"/)
  })

  it('4. no Intelligence insight recommendation text or UI label on either page names a mutating admin action (ban/suspend/approve/reject/refund/release payout/etc.)', () => {
    const forbidden = />(Approve|Reject|Suspend|Ban|Refund|Pay|Release|Resolve|Change Price|Change Plan|Contact User|Run Campaign)</
    expect(homepage).not.toMatch(forbidden)
    expect(intelligencePage).not.toMatch(forbidden)
  })

  it('5. the Intelligence page carries a visible "recommendation only" style badge', () => {
    expect(intelligencePage).toMatch(/badge="Recommendation only"/i)
  })
})

describe('Admin Intelligence page E2 explainability/diagnostics wiring (category: ADMIN-CONTROL-CENTRE-BATCH-E2)', () => {
  const homepage = readFileSync(join(REPO_ROOT, 'src/app/admin/page.tsx'), 'utf-8')
  const intelligencePage = readFileSync(join(REPO_ROOT, 'src/app/admin/intelligence/page.tsx'), 'utf-8')

  it('6. the Intelligence page renders a Source Health section driven by the service\'s own sourceHealth field, not a re-derived or hardcoded source list', () => {
    expect(intelligencePage).toMatch(/SourceHealthSection/)
    expect(intelligencePage).toMatch(/sourceHealth=\{result\.sourceHealth\}/)
    expect(intelligencePage).toMatch(/source health/i)
  })

  it('7. the Source Health section distinguishes available from degraded sources without alarming styling on a healthy source', () => {
    expect(intelligencePage).toMatch(/Available/)
    expect(intelligencePage).toMatch(/Degraded/)
    // Only the degraded branch gets the attention color; "degraded ?" is the sole conditional driving that style.
    expect(intelligencePage).toMatch(/degraded\s*\?\s*'border-amber-300/)
  })

  it('8. each insight card exposes rule ID, trigger, limitations, and freshness -- the E2 explainability fields -- behind a non-mutating expandable detail', () => {
    expect(intelligencePage).toMatch(/insight\.ruleId/)
    expect(intelligencePage).toMatch(/insight\.trigger/)
    expect(intelligencePage).toMatch(/insight\.limitations/)
    expect(intelligencePage).toMatch(/insight\.freshness/)
    expect(intelligencePage).toMatch(/<details/)
  })

  it('9. the explainability detail never introduces a mutation control (no button/form, no onClick/onSubmit handler)', () => {
    expect(intelligencePage).not.toMatch(/<button/i)
    expect(intelligencePage).not.toMatch(/<form/i)
    expect(intelligencePage).not.toMatch(/onClick=|onSubmit=/)
  })

  it('10. the zero-state ("no business insights clear the bar") and the data-quality section both still render unconditionally -- the E2 additions sit alongside them, not in place of them', () => {
    expect(intelligencePage).toMatch(/No business insights currently clear the data-sufficiency bar/)
    expect(intelligencePage).toMatch(/dataQualityInsights\.map/)
  })

  it('11. the homepage degraded-source indicator, when present, is derived from the service\'s own sourceHealth field and only rendered when something is actually degraded', () => {
    expect(homepage).toMatch(/intelligence\.sourceHealth\.filter/)
    expect(homepage).toMatch(/degradedSourceCount > 0/)
  })

  it('12. no new mutation action label was introduced by the E2 additions on either page', () => {
    const forbidden = />(Approve|Reject|Suspend|Ban|Refund|Pay|Release|Resolve|Change Price|Change Plan|Contact User|Run Campaign|Dismiss|Acknowledge|Mark Reviewed)</
    expect(homepage).not.toMatch(forbidden)
    expect(intelligencePage).not.toMatch(forbidden)
  })
})
