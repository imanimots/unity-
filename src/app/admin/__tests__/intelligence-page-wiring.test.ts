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
    expect(homepage).toMatch(/import\s*\{\s*getIntelligenceInsights\s*\}\s*from\s*'@\/lib\/admin\/intelligence-service'/)
    expect(intelligencePage).toMatch(/getIntelligenceInsights[^}]*\}\s*from\s*'@\/lib\/admin\/intelligence-service'/)
  })

  it('2. the homepage card reads only from the shared summary object (highPriority/opportunities/dataQualityLimitations), never recomputing or filtering the insight list itself', () => {
    expect(homepage).toMatch(/intelligence\.summary\.highPriority/)
    expect(homepage).toMatch(/intelligence\.summary\.opportunities/)
    expect(homepage).toMatch(/intelligence\.summary\.dataQualityLimitations/)
    // The homepage never maps/filters the raw insights array -- it must not duplicate the page's own rendering of individual insight cards.
    expect(homepage).not.toMatch(/intelligence\.insights\.(map|filter)/)
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
