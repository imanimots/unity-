import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// D2-F1 remediation (ADMIN-CONTROL-CENTRE-BATCH-D2-F1): proves the
// architectural correction at the source level. This repo's vitest
// config has no jsdom/component-test infrastructure (confirmed
// elsewhere -- src/lib/personalization/__tests__/anonymous.test.ts's
// own header comment), so a real "does the RSC actually render without
// firing analytics" test isn't practical here. This is the smallest
// reasonable source/architecture assertion instead: no analytics
// side-effect call survives in the two Server Component files that
// used to have one, and each now renders the replacement client
// tracker instead.
const REPO_ROOT = join(__dirname, '../../../..')

function readSource(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), 'utf-8')
}

/** Strips /** block comments and // line comments -- so prose explaining WHY classification is server-derived (which legitimately mentions these terms) doesn't trip a check for actual CODE usage. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

describe('RSC analytics side-effect removal (category: ADMIN-CONTROL-CENTRE-BATCH-D2-F1)', () => {
  it('1. the listing-detail Server Component no longer imports or calls recordAnalyticsEvent', () => {
    const source = readSource('src/app/[locale]/(marketing)/listings/[id]/page.tsx')
    expect(source).not.toMatch(/recordAnalyticsEvent/)
  })

  it('2. the listing-detail Server Component renders <ListingViewTracker> instead', () => {
    const source = readSource('src/app/[locale]/(marketing)/listings/[id]/page.tsx')
    expect(source).toMatch(/import \{ ListingViewTracker \} from '@\/components\/analytics\/listing-view-tracker'/)
    expect(source).toMatch(/<ListingViewTracker\s+listingId=\{listing\.id\}/)
  })

  it('3. the browse/search Server Component no longer imports or calls recordAnalyticsEvent', () => {
    const source = readSource('src/app/[locale]/(marketing)/listings/page.tsx')
    expect(source).not.toMatch(/recordAnalyticsEvent/)
  })

  it('4. the browse/search Server Component renders <SearchAnalyticsTracker> instead, with a routeKey prop (never raw query text)', () => {
    const source = readSource('src/app/[locale]/(marketing)/listings/page.tsx')
    expect(source).toMatch(/import \{ SearchAnalyticsTracker \} from '@\/components\/analytics\/search-analytics-tracker'/)
    expect(source).toMatch(/<SearchAnalyticsTracker/)
    expect(source).toMatch(/routeKey=\{routeKey\}/)
  })

  it('5. ListingViewTracker and SearchAnalyticsTracker are both real client components ("use client")', () => {
    expect(readSource('src/components/analytics/listing-view-tracker.tsx')).toMatch(/^'use client'/)
    expect(readSource('src/components/analytics/search-analytics-tracker.tsx')).toMatch(/^'use client'/)
  })

  it('6. ListingViewTracker never reads or forwards is_test/data_classification/actor_state from its own props/code -- classification stays server-derived in the ingestion route', () => {
    const code = stripComments(readSource('src/components/analytics/listing-view-tracker.tsx'))
    expect(code).not.toMatch(/is_test/)
    expect(code).not.toMatch(/dataClassification/)
    expect(code).not.toMatch(/actorState/)
  })

  it('7. SearchAnalyticsTracker never reads or forwards is_test/data_classification/actor_state in code, and never references raw query text', () => {
    const code = stripComments(readSource('src/components/analytics/search-analytics-tracker.tsx'))
    expect(code).not.toMatch(/is_test/)
    expect(code).not.toMatch(/dataClassification/)
    expect(code).not.toMatch(/actorState/)
    expect(code).not.toMatch(/\braw_?[qQ]uery\b/)
  })

  it('8. the remaining server-side workflow call sites use await, not fire-and-forget void', () => {
    const serverWorkflowFiles = [
      'src/app/api/bookings/route.ts',
      'src/app/api/orders/route.ts',
      'src/app/api/listings/route.ts',
      'src/app/api/admin/listings/[id]/activate/route.ts',
      'src/app/api/verification/submit/route.ts',
      'src/app/api/verification/resubmit/route.ts',
    ]
    for (const relPath of serverWorkflowFiles) {
      const source = readSource(relPath)
      expect(source, `${relPath} should not fire-and-forget recordAnalyticsEvent`).not.toMatch(/void recordAnalyticsEvent/)
      expect(source, `${relPath} should await recordAnalyticsEvent`).toMatch(/await recordAnalyticsEvent/)
    }
  })
})
