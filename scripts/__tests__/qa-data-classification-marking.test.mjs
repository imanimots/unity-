import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

// D3-A/F1 (ADMIN-CONTROL-CENTRE-BATCH-D3-A-F1) -- source-assertion
// coverage proving every QA account-creation path this repository's
// own tooling owns marks the resulting profile
// data_classification = 'test', so future QA-seeded accounts are
// classifiable without relying on email-domain heuristics at
// runtime. These scripts have no execution harness of their own
// (they require live Supabase credentials and mutate a real, if
// QA-designated, project) -- a focused source assertion is the
// smallest reasonable coverage, per this phase's own brief.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function readSource(relPath) {
  return readFileSync(join(REPO_ROOT, relPath), 'utf-8')
}

describe('QA tooling marks every created profile data_classification = \'test\' (category: ADMIN-CONTROL-CENTRE-BATCH-D3-A-F1)', () => {
  it('1. qa-seed.mjs ensureUser() sets data_classification: \'test\' on every profile it creates/updates', () => {
    const source = readSource('scripts/qa-seed.mjs')
    const fnStart = source.indexOf('async function ensureUser(')
    expect(fnStart).toBeGreaterThanOrEqual(0)
    const fnBody = source.slice(fnStart, source.indexOf('\n}', fnStart))
    expect(fnBody).toMatch(/from\('profiles'\)\.update\(\{[^}]*data_classification:\s*'test'/)
  })

  it('2. qa-seed.mjs seedEmailFailureFixtures() sets data_classification: \'test\' for both email-failure fixture accounts', () => {
    const source = readSource('scripts/qa-seed.mjs')
    const fnStart = source.indexOf('async function seedEmailFailureFixtures(')
    expect(fnStart).toBeGreaterThanOrEqual(0)
    const fnBody = source.slice(fnStart, source.indexOf('\n}', fnStart))
    expect(fnBody).toMatch(/from\('profiles'\)\.update\(\{\s*data_classification:\s*'test'/)
  })

  it.each([
    'scripts/verify-marketplace-request-account-status.mjs',
    'scripts/verify-listing-pause-resume.mjs',
    'scripts/verify-affiliate-system.mjs',
    'scripts/verify-rtb-dispute-evidence-storage.mjs',
    'scripts/verify-commissions-phase2.mjs',
  ])('3. %s marks its disposable QA accounts data_classification: \'test\'', (relPath) => {
    const source = readSource(relPath)
    expect(source).toMatch(/from\('profiles'\)\.update\(\{[^}]*data_classification:\s*'test'/)
  })

  it('4. none of these scripts classify by email domain string-matching as the data_classification VALUE itself (it is always the literal \'test\', never an email.endsWith()/includes() expression)', () => {
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
      expect(source, relPath).not.toMatch(/data_classification:\s*email\./)
      expect(source, relPath).not.toMatch(/data_classification:\s*.*\.endsWith\(/)
    }
  })

  it('5. none of these scripts write profiles.is_test anywhere -- the boolean field was fully replaced by data_classification, not kept as a second field', () => {
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
      // Only the PROFILES update call sites must never mention is_test --
      // entity-level is_test (listings.is_test, marketplace_requests.is_test)
      // remains untouched and legitimate, so this checks the specific
      // profiles().update(...) call expressions only, not the whole file.
      const profileUpdateCalls = source.match(/from\('profiles'\)\.update\(\{[^}]*\}\)/g) ?? []
      for (const call of profileUpdateCalls) {
        expect(call, `${relPath}: ${call}`).not.toMatch(/is_test/)
      }
    }
  })
})
