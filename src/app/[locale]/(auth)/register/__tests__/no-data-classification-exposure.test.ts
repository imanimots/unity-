import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'

// D3-A/F1 (ADMIN-CONTROL-CENTRE-BATCH-D3-A-F1) -- source-assertion
// proving profiles.data_classification has no client-facing write
// path. The database-level protection
// (protect_profile_privileged_fields() trigger, verified in
// supabase/migrations/__tests__/profiles-data-classification-migration.test.ts)
// is the authoritative guarantee; this test additionally proves the
// application layer never even attempts to forward a client-supplied
// data_classification value, so an ordinary profile mutation request
// never carries the field at all.
const REPO_ROOT = join(__dirname, '../../../../../..')

function readSource(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), 'utf-8')
}

describe('profiles.data_classification has no client-facing write path (category: ADMIN-CONTROL-CENTRE-BATCH-D3-A-F1)', () => {
  it('1. the public registration page never includes data_classification in its profile upsert payload', () => {
    const source = readSource('src/app/[locale]/(auth)/register/page.tsx')
    const upsertStart = source.indexOf("from('profiles').upsert(")
    expect(upsertStart).toBeGreaterThanOrEqual(0)
    const upsertBody = source.slice(upsertStart, source.indexOf('})', upsertStart))
    expect(upsertBody).not.toMatch(/data_classification/)
  })

  it('2. the business-name self-service route never accepts or forwards data_classification', () => {
    const source = readSource('src/app/api/subscriptions/business-name/route.ts')
    expect(source).not.toMatch(/data_classification/)
  })

  it('3. no API route anywhere under src/app/api sets profiles.data_classification via an update/upsert call', () => {
    // Narrow and precise: find every actual `.from('profiles').update(...)`
    // or `.from('profiles').upsert(...)` call expression under src/app/api,
    // with 5 lines of trailing context, and check only that context for
    // data_classification -- not the whole file's text, which would
    // false-positive on unrelated prose (e.g. a documentation comment
    // listing "profiles" and "data_classification" together in an
    // unrelated sentence).
    const output = execSync(
      `grep -rn -A5 "from('profiles')\\.\\(update\\|upsert\\)(" src/app/api 2>/dev/null || true`,
      { cwd: REPO_ROOT, encoding: 'utf-8' }
    )
    expect(output).not.toMatch(/data_classification/)
  })

  it('4. no production source anywhere references profiles.is_test -- the boolean field was fully replaced, not kept as a second field', () => {
    const output = execSync(
      `grep -rln "is_test" src/app/api "src/app/[locale]" --exclude-dir=__tests__ --exclude="*.test.ts" 2>/dev/null || true`,
      { cwd: REPO_ROOT, encoding: 'utf-8' }
    )
    const hits = output.split('\n').filter(Boolean)
    for (const file of hits) {
      const source = readSource(file)
      // Entity-level is_test (listings, marketplace_requests, etc.) is
      // legitimate and untouched -- only a PROFILES-scoped reference
      // would be a remnant of the replaced boolean field.
      expect(source, file).not.toMatch(/profiles.*is_test|is_test.*profiles/)
    }
  })
})
