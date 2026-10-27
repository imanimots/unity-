import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// DB-free regression guards over the raw migration SQL text -- same
// convention as src/lib/payments/__tests__/webhook-inbox-migration.test.ts
// and supabase/migrations/__tests__/analytics-events-foundation-migration.test.ts.
// No database connection: this only proves the migration SOURCE contains
// the invariants D3-A requires, not that it has been applied anywhere
// (it has not -- this phase does not apply the migration).
const REPO_ROOT = join(__dirname, '../../..')
const migrationPath = join(REPO_ROOT, 'supabase/migrations/20261027150000_profiles_is_test_classification.sql')
const sql = readFileSync(migrationPath, 'utf-8')

function functionBody(name: string): string {
  const marker = `create or replace function public.${name}`
  const idx = sql.indexOf(marker)
  expect(idx, `expected to find "${marker}" in the migration`).toBeGreaterThanOrEqual(0)
  return sql.slice(idx).split('$$;')[0]
}

// The 3 proven historical @unitytest.co.za UUIDs this migration enumerates --
// kept here as the single source of truth the tests below check against,
// so a future accidental addition/removal is immediately caught.
const PROVEN_CO_ZA_IDS = [
  '55b01021-c9be-4f0e-b298-d865ab21feea',
  '0a4c00d5-a20e-4a12-bb2c-104e66399c7c',
  '2b418e42-d343-48cb-9d98-f966ef94d749',
]

describe('D3-A profiles.is_test classification migration invariants (category: ADMIN-CONTROL-CENTRE-BATCH-D3-A)', () => {
  it('1. adds profiles.is_test as a non-null boolean defaulting to false', () => {
    expect(sql).toMatch(/alter table public\.profiles add column if not exists is_test boolean not null default false/)
  })

  it('2. is additive (ALTER TABLE ADD COLUMN), never drops or rewrites an existing profiles column', () => {
    expect(sql).not.toMatch(/drop column/i)
    expect(sql).not.toMatch(/alter column/i)
  })

  it('3. extends the existing protect_profile_privileged_fields() trigger function, not a new mechanism', () => {
    expect(sql).toMatch(/create or replace function public\.protect_profile_privileged_fields\(\)/)
    // Must NOT create a second, competing trigger -- this migration only redefines the function body.
    expect(sql).not.toMatch(/create trigger/i)
  })

  it('4. the trigger reverts is_test for any non-service_role caller, inside the existing (outer) auth.role() guard -- not merely somewhere in the function', () => {
    const fnBody = functionBody('protect_profile_privileged_fields')
    const guardIdx = fnBody.indexOf("if auth.role() <> 'service_role' then")
    expect(guardIdx).toBeGreaterThanOrEqual(0)
    const isTestIdx = fnBody.indexOf('new.is_test := old.is_test;')
    const returnIdx = fnBody.indexOf('return new;')
    // The LAST "end if;" before `return new;` closes the OUTER guard (the
    // function has exactly one nested if/end-if inside it, for
    // pg_trigger_depth()) -- is_test must appear before that outer close,
    // not merely after the guard opens.
    const outerEndIfIdx = fnBody.lastIndexOf('end if;', returnIdx)
    expect(isTestIdx, 'expected new.is_test := old.is_test; inside the function body').toBeGreaterThan(guardIdx)
    expect(isTestIdx).toBeLessThan(outerEndIfIdx)
  })

  it('5. preserves every pre-existing protected field in the same trigger -- role, kyc_status, unity_score, is_affiliate, affiliate_code', () => {
    const fnBody = functionBody('protect_profile_privileged_fields')
    expect(fnBody).toMatch(/new\.role := old\.role;/)
    expect(fnBody).toMatch(/new\.kyc_status := old\.kyc_status;/)
    expect(fnBody).toMatch(/new\.unity_score := old\.unity_score;/)
    expect(fnBody).toMatch(/new\.is_affiliate := old\.is_affiliate;/)
    expect(fnBody).toMatch(/new\.affiliate_code := old\.affiliate_code;/)
  })

  it('6. the trigger function remains SECURITY DEFINER with an explicit search_path, matching the original', () => {
    const fnBody = functionBody('protect_profile_privileged_fields')
    expect(fnBody).toMatch(/security definer/)
    expect(fnBody).toMatch(/set search_path = public/)
  })

  it('7. backfills @unitytest.internal via an exact, case-insensitive domain-suffix match against auth.users.email', () => {
    expect(sql).toMatch(/lower\(email\) like '%@unitytest\.internal'/)
  })

  it('8. does NOT backfill @unitytest.co.za via any domain-wide LIKE/pattern match -- the string may appear in traceability comments only, never in a WHERE/IN predicate', () => {
    expect(sql.toLowerCase()).not.toMatch(/like\s+'%@unitytest\.co\.za/)
    expect(sql.toLowerCase()).not.toMatch(/email.*unitytest\.co\.za.*like|like.*unitytest\.co\.za/)
    // Every appearance of the string is inside a `--` inline/standalone
    // comment (i.e. a `--` marker precedes it on the same line), never
    // part of active SQL (a WHERE/LIKE predicate).
    for (const line of sql.split('\n')) {
      const idx = line.toLowerCase().indexOf('unitytest.co.za')
      if (idx === -1) continue
      const commentIdx = line.indexOf('--')
      expect(commentIdx, `expected a "--" comment marker before unitytest.co.za on line: ${line}`).toBeGreaterThanOrEqual(0)
      expect(commentIdx, `expected unitytest.co.za to appear after "--" on line: ${line}`).toBeLessThan(idx)
    }
  })

  it('9. the @unitytest.co.za backfill enumerates exactly the 3 proven historical QA account UUIDs, no more and no fewer', () => {
    const idListSection = sql.split('-- B. @unitytest.co.za')[1]
    expect(idListSection, 'expected a dedicated section B for the co.za backfill').toBeDefined()
    for (const id of PROVEN_CO_ZA_IDS) {
      expect(idListSection).toMatch(new RegExp(id))
    }
    // Exactly 3 UUID literals in this section's `in (...)` list -- not a 4th unproven one.
    const uuidMatches = idListSection!.match(/'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'/g) ?? []
    expect(uuidMatches.length).toBe(3)
  })

  it('10. both backfill UPDATEs are scoped to is_test = false, never touch created_at/role/account_status/kyc_status/names/phone/country/business_name', () => {
    const forbiddenColumns = ['created_at', 'role =', 'account_status', 'kyc_status', 'full_name', 'display_name', 'phone', 'country_id', 'business_name']
    const updateSections = sql.split(/update public\.profiles/).slice(1)
    expect(updateSections.length).toBe(2)
    for (const section of updateSections) {
      const setClause = section.split('where')[0]!
      expect(setClause).toMatch(/set is_test = true/)
      expect(section).toMatch(/where is_test = false/)
      for (const col of forbiddenColumns) {
        expect(setClause, `set clause should not touch ${col}`).not.toMatch(new RegExp(col))
      }
    }
  })

  it('11. never backfills a gmail.com account -- the string may appear only in a comment documenting that none was included, never on an active SQL line', () => {
    for (const line of sql.split('\n')) {
      if (line.toLowerCase().includes('gmail.com')) {
        expect(line.trim().startsWith('--'), `expected only a comment line to mention gmail.com, got: ${line}`).toBe(true)
      }
    }
  })

  it('12. does not touch any entity-level is_test column (listings, marketplace_requests, barter_skill_task_posts, rent_to_buy_agreements, reviews, ad_campaigns)', () => {
    for (const table of ['listings', 'marketplace_requests', 'barter_skill_task_posts', 'rent_to_buy_agreements', 'reviews', 'ad_campaigns']) {
      expect(sql).not.toMatch(new RegExp(`update public\\.${table}`))
      expect(sql).not.toMatch(new RegExp(`alter table public\\.${table}`))
    }
  })

  it('13. does not grant any new RLS policy or widen an existing one -- no "create policy" statement at all', () => {
    expect(sql).not.toMatch(/create policy/i)
  })
})
