import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

// D3-A (ADMIN-CONTROL-CENTRE-BATCH-D3-A) -- source-assertion coverage
// proving every QA account-creation path this repository's own
// tooling owns marks the resulting profile is_test = true, so future
// QA-seeded accounts are classifiable without relying on email-domain
// heuristics at runtime. These scripts have no execution harness of
// their own (they require live Supabase credentials and mutate a
// real, if QA-designated, project) -- a focused source assertion is
// the smallest reasonable coverage, per this phase's own brief.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function readSource(relPath) {
  return readFileSync(join(REPO_ROOT, relPath), 'utf-8')
}

describe('QA tooling marks every created profile is_test = true (category: ADMIN-CONTROL-CENTRE-BATCH-D3-A)', () => {
  it('1. qa-seed.mjs ensureUser() sets is_test: true on every profile it creates/updates', () => {
    const source = readSource('scripts/qa-seed.mjs')
    const fnStart = source.indexOf('async function ensureUser(')
    expect(fnStart).toBeGreaterThanOrEqual(0)
    const fnBody = source.slice(fnStart, source.indexOf('\n}', fnStart))
    expect(fnBody).toMatch(/from\('profiles'\)\.update\(\{[^}]*is_test:\s*true/)
  })

  it('2. qa-seed.mjs seedEmailFailureFixtures() sets is_test: true for both email-failure fixture accounts', () => {
    const source = readSource('scripts/qa-seed.mjs')
    const fnStart = source.indexOf('async function seedEmailFailureFixtures(')
    expect(fnStart).toBeGreaterThanOrEqual(0)
    const fnBody = source.slice(fnStart, source.indexOf('\n}', fnStart))
    expect(fnBody).toMatch(/from\('profiles'\)\.update\(\{\s*is_test:\s*true/)
  })

  it.each([
    'scripts/verify-marketplace-request-account-status.mjs',
    'scripts/verify-listing-pause-resume.mjs',
    'scripts/verify-affiliate-system.mjs',
    'scripts/verify-rtb-dispute-evidence-storage.mjs',
    'scripts/verify-commissions-phase2.mjs',
  ])('3. %s marks its disposable QA accounts is_test: true', (relPath) => {
    const source = readSource(relPath)
    expect(source).toMatch(/from\('profiles'\)\.update\(\{[^}]*is_test:\s*true/)
  })

  it('4. none of these scripts classify by email domain string-matching as the is_test VALUE itself (is_test is always the literal true, never an email.endsWith()/includes() expression)', () => {
    const files = [
      'scripts/qa-seed.mjs',
      'scripts/verify-marketplace-request-account-status.mjs',
      'scripts/verify-listing-pause-resume.mjs',
      'scripts/verify-affiliate-system.mjs',
      'scripts/verify-rtb-dispute-evidence-storage.mjs',
      'scripts/verify-commissions-phase2.mjs',
    ]
    for (const relPath of files) {
      const source = readSource(relPath)
      expect(source, relPath).not.toMatch(/is_test:\s*email\./)
      expect(source, relPath).not.toMatch(/is_test:\s*.*\.endsWith\(/)
    }
  })
})
