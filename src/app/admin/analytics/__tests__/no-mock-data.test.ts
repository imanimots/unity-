import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const REPO_ROOT = join(__dirname, '../../../../..')

/**
 * ADMIN-CONTROL-CENTRE-BATCH-D1 Part 8 -- the production /admin/analytics
 * route and its data layer must contain no reference to the mock
 * analytics fixtures, and no hard-coded fake metric value left over
 * from the old mock-backed page.
 */
describe('no mock analytics data in the production analytics path (category: ADMIN-CONTROL-CENTRE-BATCH-D1)', () => {
  const FILES = [
    'src/app/admin/analytics/page.tsx',
    'src/app/api/admin/analytics/route.ts',
    'src/lib/admin/analytics-service.ts',
  ]

  it.each(FILES)('%s never imports @/lib/mock/admin-data', (relPath) => {
    const content = readFileSync(join(REPO_ROOT, relPath), 'utf-8')
    // Matches an actual import/require statement, not an explanatory
    // comment that merely mentions the module by name (e.g. this file's
    // own header comment stating that it does NOT read from it).
    expect(content).not.toMatch(/(?:from|require\()\s*['"]@\/lib\/mock\/admin-data['"]/)
  })

  it('the analytics page never hard-codes the old mock KPI values (e.g. "Cameras", "R2,114", "4.2%")', () => {
    const content = readFileSync(join(REPO_ROOT, 'src/app/admin/analytics/page.tsx'), 'utf-8')
    expect(content).not.toContain('4.2%')
    expect(content).not.toContain('R2,114')
    expect(content).not.toContain('ANALYTICS_BOOKING_VOLUME')
    expect(content).not.toContain('ANALYTICS_TOP_MERCHANTS')
  })
})
