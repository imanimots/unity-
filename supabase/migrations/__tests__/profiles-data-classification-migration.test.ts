import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// DB-free regression guards over the raw migration SQL text -- same
// convention as src/lib/payments/__tests__/webhook-inbox-migration.test.ts
// and supabase/migrations/__tests__/analytics-events-foundation-migration.test.ts.
// No database connection: this only proves the migration SOURCE
// contains the invariants D3-A-F1 requires, not that it has been
// applied anywhere (it has not -- this phase does not apply it).
const REPO_ROOT = join(__dirname, '../../..')
const migrationPath = join(REPO_ROOT, 'supabase/migrations/20261027150000_profiles_data_classification.sql')
const sql = readFileSync(migrationPath, 'utf-8')

function functionBody(name: string): string {
  const marker = `create or replace function public.${name}`
  const idx = sql.indexOf(marker)
  expect(idx, `expected to find "${marker}" in the migration`).toBeGreaterThanOrEqual(0)
  return sql.slice(idx).split('$$;')[0]
}

const PROVEN_CO_ZA_IDS = [
  '55b01021-c9be-4f0e-b298-d865ab21feea',
  '0a4c00d5-a20e-4a12-bb2c-104e66399c7c',
  '2b418e42-d343-48cb-9d98-f966ef94d749',
]

describe('D3-A-F1 profiles.data_classification three-state migration invariants (category: ADMIN-CONTROL-CENTRE-BATCH-D3-A-F1)', () => {
  it('1. adds profiles.data_classification as a non-null text column, with its initial (legacy) default of \'unknown\'', () => {
    expect(sql).toMatch(
      /alter table public\.profiles\s*\n\s*add column if not exists data_classification text not null default 'unknown'/
    )
  })

  it('2. the CHECK constraint allows exactly real/test/unknown -- no other value', () => {
    expect(sql).toMatch(/check \(data_classification in \('real', 'test', 'unknown'\)\)/)
  })

  it('3. does NOT create a profiles.is_test boolean column -- the three-state model replaces it entirely, never adds a second field', () => {
    expect(sql).not.toMatch(/profiles\.is_test/)
    expect(sql).not.toMatch(/add column if not exists is_test/)
  })

  it('4. is additive/alters only this one column -- never drops or type-changes an existing profiles column', () => {
    expect(sql).not.toMatch(/drop column/i)
    // The only ACTIVE "alter column" statement in the whole file must be the
    // final SET DEFAULT (Step 3) -- never a type change. Comment lines that
    // merely explain ALTER COLUMN's semantics in prose don't count.
    const activeAlterColumnLines = sql
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .filter((l) => /alter column/i.test(l))
    expect(activeAlterColumnLines.length).toBe(1)
    expect(activeAlterColumnLines[0]).toMatch(/alter column data_classification set default 'real'/)
  })

  it('5. Step 3 (the final "real" default) appears strictly AFTER both Step 2 backfill UPDATEs in the file -- ordering is load-bearing, not incidental', () => {
    const step3Idx = sql.indexOf("alter column data_classification set default 'real'")
    const backfillAIdx = sql.indexOf("update public.profiles\nset data_classification = 'test'\nwhere data_classification = 'unknown'\n  and id in (\n    select id from auth.users")
    const backfillBIdx = sql.indexOf("'55b01021-c9be-4f0e-b298-d865ab21feea'")
    expect(step3Idx).toBeGreaterThan(backfillAIdx)
    expect(step3Idx).toBeGreaterThan(backfillBIdx)
  })

  it('6. extends the existing protect_profile_privileged_fields() trigger function, not a new mechanism', () => {
    expect(sql).toMatch(/create or replace function public\.protect_profile_privileged_fields\(\)/)
    expect(sql).not.toMatch(/create trigger/i)
  })

  it('7. the trigger reverts data_classification for any non-service_role caller, inside the existing (outer) auth.role() guard', () => {
    const fnBody = functionBody('protect_profile_privileged_fields')
    const guardIdx = fnBody.indexOf("if auth.role() <> 'service_role' then")
    expect(guardIdx).toBeGreaterThanOrEqual(0)
    const fieldIdx = fnBody.indexOf('new.data_classification := old.data_classification;')
    const returnIdx = fnBody.indexOf('return new;')
    const outerEndIfIdx = fnBody.lastIndexOf('end if;', returnIdx)
    expect(fieldIdx, 'expected new.data_classification := old.data_classification; inside the function body').toBeGreaterThan(guardIdx)
    expect(fieldIdx).toBeLessThan(outerEndIfIdx)
  })

  it('8. no profiles.is_test protection remains in the trigger -- fully replaced', () => {
    const fnBody = functionBody('protect_profile_privileged_fields')
    expect(fnBody).not.toMatch(/is_test/)
  })

  it('9. preserves every pre-existing protected field in the same trigger -- role, kyc_status, unity_score, is_affiliate, affiliate_code', () => {
    const fnBody = functionBody('protect_profile_privileged_fields')
    expect(fnBody).toMatch(/new\.role := old\.role;/)
    expect(fnBody).toMatch(/new\.kyc_status := old\.kyc_status;/)
    expect(fnBody).toMatch(/new\.unity_score := old\.unity_score;/)
    expect(fnBody).toMatch(/new\.is_affiliate := old\.is_affiliate;/)
    expect(fnBody).toMatch(/new\.affiliate_code := old\.affiliate_code;/)
  })

  it('10. backfills @unitytest.internal to \'test\' via an exact, case-insensitive domain-suffix match against auth.users.email', () => {
    expect(sql).toMatch(/lower\(email\) like '%@unitytest\.internal'/)
    const section = sql.split('-- A. @unitytest.internal')[1]!.split('-- B.')[0]!
    expect(section).toMatch(/set data_classification = 'test'/)
  })

  it('11. does NOT backfill @unitytest.co.za via any domain-wide match -- only an explicit UUID list, and the string appears only in comments', () => {
    for (const line of sql.split('\n')) {
      const idx = line.toLowerCase().indexOf('unitytest.co.za')
      if (idx === -1) continue
      const commentIdx = line.indexOf('--')
      expect(commentIdx, `expected a "--" comment marker before unitytest.co.za on line: ${line}`).toBeGreaterThanOrEqual(0)
      expect(commentIdx, `expected unitytest.co.za to appear after "--" on line: ${line}`).toBeLessThan(idx)
    }
  })

  it('12. the @unitytest.co.za backfill enumerates exactly the 3 proven historical QA account UUIDs, no more and no fewer', () => {
    const idListSection = sql.split('-- B. @unitytest.co.za')[1]
    expect(idListSection).toBeDefined()
    for (const id of PROVEN_CO_ZA_IDS) {
      expect(idListSection).toMatch(new RegExp(id))
    }
    const uuidMatches = idListSection!.match(/'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'/g) ?? []
    expect(uuidMatches.length).toBe(3)
  })

  it('13. both Step 2 backfill UPDATEs are scoped to data_classification = \'unknown\' (idempotent, legacy-only), never touch created_at/role/account_status/kyc_status/names/phone/country/business_name', () => {
    const forbiddenColumns = ['created_at', 'role =', 'account_status', 'kyc_status', 'full_name', 'display_name', 'phone', 'country_id', 'business_name']
    const updateSections = sql.split(/update public\.profiles/).slice(1)
    expect(updateSections.length).toBe(2)
    for (const section of updateSections) {
      const setClause = section.split('where')[0]!
      expect(setClause).toMatch(/set data_classification = 'test'/)
      expect(section).toMatch(/where data_classification = 'unknown'/)
      for (const col of forbiddenColumns) {
        expect(setClause, `set clause should not touch ${col}`).not.toMatch(new RegExp(col))
      }
    }
  })

  it('14. never backfills a gmail.com account -- the string may appear only in a comment, never on an active SQL line', () => {
    for (const line of sql.split('\n')) {
      if (line.toLowerCase().includes('gmail.com')) {
        expect(line.trim().startsWith('--'), `expected only a comment line to mention gmail.com, got: ${line}`).toBe(true)
      }
    }
  })

  it('15. does NOT contain a bulk "classify everything else real" pass -- no UPDATE sets data_classification to \'real\' anywhere (every row either becomes \'test\' via the two scoped backfills, or stays at the \'unknown\' default)', () => {
    expect(sql).not.toMatch(/update public\.profiles\s*\nset data_classification = 'real'/)
    expect(sql).not.toMatch(/set data_classification = 'real'/)
  })

  it('16. the final column DEFAULT becomes \'real\' only via ALTER COLUMN SET DEFAULT -- which never rewrites existing rows, only affects future inserts', () => {
    expect(sql).toMatch(/alter table public\.profiles alter column data_classification set default 'real';/)
  })

  it('17. does not touch any entity-level is_test column (listings, marketplace_requests, barter_skill_task_posts, rent_to_buy_agreements, reviews, review_replies, review_windows, ad_campaigns)', () => {
    for (const table of ['listings', 'marketplace_requests', 'barter_skill_task_posts', 'rent_to_buy_agreements', 'reviews', 'review_replies', 'review_windows', 'ad_campaigns']) {
      expect(sql).not.toMatch(new RegExp(`update public\\.${table}`))
      expect(sql).not.toMatch(new RegExp(`alter table public\\.${table}`))
    }
  })

  it('18. does not grant any new RLS policy or widen an existing one -- no "create policy" statement at all', () => {
    expect(sql).not.toMatch(/create policy/i)
  })
})
