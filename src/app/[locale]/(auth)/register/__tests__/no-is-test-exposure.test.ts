import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'

// D3-A (ADMIN-CONTROL-CENTRE-BATCH-D3-A) -- source-assertion proving
// profiles.is_test has no client-facing write path. The database-level
// protection (protect_profile_privileged_fields() trigger, verified in
// supabase/migrations/__tests__/profiles-is-test-classification-migration.test.ts)
// is the authoritative guarantee; this test additionally proves the
// application layer never even attempts to forward a client-supplied
// is_test value, so an ordinary profile mutation request never
// carries the field at all.
const REPO_ROOT = join(__dirname, '../../../../../..')

function readSource(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), 'utf-8')
}

describe('profiles.is_test has no client-facing write path (category: ADMIN-CONTROL-CENTRE-BATCH-D3-A)', () => {
  it('1. the public registration page never includes is_test in its profile upsert payload', () => {
    const source = readSource('src/app/[locale]/(auth)/register/page.tsx')
    const upsertStart = source.indexOf("from('profiles').upsert(")
    expect(upsertStart).toBeGreaterThanOrEqual(0)
    const upsertBody = source.slice(upsertStart, source.indexOf('})', upsertStart))
    expect(upsertBody).not.toMatch(/is_test/)
  })

  it('2. the business-name self-service route never accepts or forwards is_test', () => {
    const source = readSource('src/app/api/subscriptions/business-name/route.ts')
    expect(source).not.toMatch(/is_test/)
  })

  it('3. no API route anywhere under src/app/api sets profiles.is_test via an update/upsert call', () => {
    // Narrow and precise: find every actual `.from('profiles').update(...)`
    // or `.from('profiles').upsert(...)` call expression under src/app/api,
    // with 5 lines of trailing context, and check only that context for
    // is_test -- not the whole file's text, which would false-positive on
    // unrelated prose (e.g. D1's own analytics-service.ts documentation
    // comment listing "profiles" and "is_test" together in an unrelated
    // sentence).
    const output = execSync(
      `grep -rn -A5 "from('profiles')\\.\\(update\\|upsert\\)(" src/app/api 2>/dev/null || true`,
      { cwd: REPO_ROOT, encoding: 'utf-8' }
    )
    expect(output).not.toMatch(/is_test/)
  })
})
