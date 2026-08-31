import { describe, it, expect } from 'vitest'
import { readdirSync } from 'fs'
import { join } from 'path'
import { PAGE_COVERAGE_MANIFEST, summarizePageCoverage } from '../page-coverage-manifest'

function findPages(dir: string, base = ''): string[] {
  let out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    const rel = base ? `${base}/${entry.name}` : entry.name
    if (entry.isDirectory()) out = out.concat(findPages(full, rel))
    else if (entry.name === 'page.tsx') out.push(rel)
  }
  return out
}

describe('page coverage manifest', () => {
  const localeDir = join(__dirname, '../../app/[locale]')
  const realPages = findPages(localeDir).sort()
  const manifestPages = PAGE_COVERAGE_MANIFEST.map((p) => p.path).sort()

  it('1. the manifest has no stale entries (every manifest path exists on disk)', () => {
    const missing = manifestPages.filter((p) => !realPages.includes(p))
    expect(missing).toEqual([])
  })

  it('2. the manifest has no drift (every real page.tsx under [locale] has a manifest entry) -- this is what catches an unclassified new customer/merchant page', () => {
    const unclassified = realPages.filter((p) => !manifestPages.includes(p))
    expect(unclassified).toEqual([])
  })

  it('3. summary counts are internally consistent', () => {
    const s = summarizePageCoverage()
    expect(s.total).toBe(s.wired + s.sharedLayout + s.unwired)
    expect(s.localizedTotal).toBe(s.wired + s.sharedLayout)
  })

  it('4. current real coverage documented as ground truth (update when genuinely changed, not to force this to pass)', () => {
    const s = summarizePageCoverage()
    expect(s.total).toBe(68)
    expect(s.wired).toBe(56)
    expect(s.sharedLayout).toBe(12)
    expect(s.localizedTotal).toBe(68)
  })

  it('5. page localization is genuinely, truthfully complete: zero unwired entries remain', () => {
    const s = summarizePageCoverage()
    expect(s.unwired).toBe(0)
    expect(s.localizedTotal).toBe(s.total)
  })
})
