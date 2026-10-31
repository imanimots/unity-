import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * E8-F1 migration-contract test for
 * 20261031180000_harden_security_definer_views.sql.
 *
 * This supersedes the original E8 test of the same file name -- the
 * underlying migration was never applied anywhere, so it was corrected
 * in place rather than superseded by a second migration (see the
 * migration's own header comment for the full architectural
 * reasoning).
 *
 * Disposition after a fresh, caller-aware re-audit:
 *   CONVERTED to security_invoker = true (narrow owner/public RLS +
 *   explicit column-level grant, replacing the role's prior
 *   table-level access): listing_moderation_merchant_view,
 *   listing_ownership_verification_merchant_view,
 *   identity_verification_self_view, ad_packages_public.
 *   RETAINED as a justified SECURITY DEFINER exception:
 *   barter_locked_listings, rent_to_buy_locked_listings,
 *   public_profiles, barter_skill_task_public_posts.
 *
 * LIMITATION, stated explicitly per this codebase's own established
 * convention: this test parses SQL source text and asserts on its
 * structure -- column lists granted, RLS predicates, security options.
 * It does NOT execute the SQL against a real Postgres instance and
 * cannot literally prove live GRANT/RLS enforcement (e.g. that a
 * direct `select reviewer_notes` actually raises a permission-denied
 * error) -- no live database is available to this test environment,
 * consistent with every other migration test in this repository. This
 * migration has not been applied by any phase; it reaches the live
 * database only via the project's GitHub-integrated Supabase workflow.
 */
const REPO_ROOT = join(__dirname, '../../..')
const MIGRATION_PATH = join(REPO_ROOT, 'supabase/migrations/20261031180000_harden_security_definer_views.sql')
const sql = readFileSync(MIGRATION_PATH, 'utf-8')

function stripComments(source: string): string {
  return source.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')
}
const codeOnly = stripComments(sql)

/** Extracts a view's SELECT body (between `as` and the terminating `;`), tolerating `as` either inline or on its own line after a `with (...)` clause. None of these 8 bodies contain an embedded `;`. */
function extractViewBody(source: string, name: string): string {
  const defIdx = source.search(new RegExp(`create (or replace )?view public\\.${name}\\b`))
  if (defIdx === -1) throw new Error(`${name}: view definition not found`)
  const afterDef = source.slice(defIdx)
  const asMatch = afterDef.match(/\bas\b[ \t]*\n/)
  if (!asMatch || asMatch.index === undefined) throw new Error(`${name}: 'as' clause not found`)
  const asIdx = defIdx + asMatch.index + asMatch[0].length
  const endIdx = source.indexOf(';', asIdx)
  if (endIdx === -1) throw new Error(`${name}: terminating ; not found`)
  return source.slice(asIdx, endIdx).trim()
}

/** Extracts the column list of a `grant select (col1, col2, ...) on public.<table> to <roles>;` statement. */
function extractColumnGrant(source: string, table: string): string[] | null {
  const match = source.match(new RegExp(`grant select \\(([^)]+)\\)\\s*\\n?\\s*on public\\.${table} to [^;]+;`, 's'))
  if (!match) return null
  return match[1].split(',').map((c) => c.trim())
}

const ORIGINAL_SOURCES: Record<string, string> = {
  listing_moderation_merchant_view: '20260729000004_listing_moderation.sql',
  listing_ownership_verification_merchant_view: '20260803000001_ownership_verification_schema.sql',
  identity_verification_self_view: '20260804000001_identity_verification_schema.sql',
  barter_locked_listings: '20260810000003_barter_schema.sql',
  rent_to_buy_locked_listings: '20260828000001_rtb_inventory_locking.sql',
  public_profiles: '20260819072454_subscription_v2_downgrade_workflow.sql',
  barter_skill_task_public_posts: '20260902000004_search_ranking_rpcs.sql',
  ad_packages_public: '20260903000002_advertising_packages.sql',
}

const CONVERTED_VIEWS = ['listing_moderation_merchant_view', 'listing_ownership_verification_merchant_view', 'identity_verification_self_view', 'ad_packages_public']
const RETAINED_VIEWS = ['barter_locked_listings', 'rent_to_buy_locked_listings', 'public_profiles', 'barter_skill_task_public_posts']
const ALL_VIEWS = [...CONVERTED_VIEWS, ...RETAINED_VIEWS]

describe('20261031180000_harden_security_definer_views.sql (category: ADMIN-CONTROL-CENTRE-BATCH-E8-F1)', () => {
  it('1. all 8 advisor-flagged views are present, each exactly once', () => {
    const definedHere = [...sql.matchAll(/create or replace view public\.(\w+)/g)].map((m) => m[1])
    expect(definedHere.sort()).toEqual([...ALL_VIEWS].sort())
  })

  it('2. every view body (columns, FROM/JOIN, WHERE) is byte-for-byte identical to its original source definition -- this migration changes privilege/RLS architecture, never view logic', () => {
    for (const name of ALL_VIEWS) {
      const sourceSql = readFileSync(join(REPO_ROOT, 'supabase/migrations', ORIGINAL_SOURCES[name]), 'utf-8')
      const originalBody = extractViewBody(sourceSql, name)
      const newBody = extractViewBody(sql, name)
      expect(newBody, `${name}: view body differs from its original source`).toBe(originalBody)
    }
  })

  it('3. the 4 converted views are security_invoker = true; the 4 retained views are security_invoker = false -- both explicit, with security_barrier = true on all 8', () => {
    for (const name of CONVERTED_VIEWS) {
      const defIdx = sql.search(new RegExp(`create or replace view public\\.${name}\\b`))
      const optionsWindow = sql.slice(defIdx, sql.indexOf(' as\n', defIdx) === -1 ? sql.indexOf('\nas\n', defIdx) : sql.indexOf(' as\n', defIdx))
      expect(optionsWindow, `${name}: expected security_invoker = true`).toMatch(/security_invoker\s*=\s*true/)
      expect(optionsWindow, `${name}: missing security_barrier = true`).toMatch(/security_barrier\s*=\s*true/)
    }
    for (const name of RETAINED_VIEWS) {
      const defIdx = sql.search(new RegExp(`create or replace view public\\.${name}\\b`))
      const optionsWindow = sql.slice(defIdx, sql.indexOf(' as\n', defIdx) === -1 ? sql.indexOf('\nas\n', defIdx) : sql.indexOf(' as\n', defIdx))
      expect(optionsWindow, `${name}: expected security_invoker = false`).toMatch(/security_invoker\s*=\s*false/)
      expect(optionsWindow, `${name}: missing security_barrier = true`).toMatch(/security_barrier\s*=\s*true/)
    }
  })

  it('4. the 3 converted self/merchant base tables (listing_moderation, listing_ownership_verification, identity_verifications) each get an explicit column-level grant that excludes every internal-only column', () => {
    const expectations: Array<{ table: string; granted: string[]; excluded: string[] }> = [
      { table: 'listing_moderation', granted: ['listing_id', 'moderation_status', 'rejection_reason', 'moderated_at'], excluded: ['moderation_notes', 'moderated_by', 'created_at', 'updated_at'] },
      { table: 'listing_ownership_verification', granted: ['listing_id', 'status', 'merchant_feedback', 'reviewed_at'], excluded: ['provider', 'provider_reference', 'reviewer_notes', 'reason_code', 'reviewed_by', 'created_at', 'updated_at'] },
      { table: 'identity_verifications', granted: ['user_id', 'status', 'legal_first_name', 'legal_surname', 'date_of_birth', 'id_reference_type', 'id_reference_number', 'nationality', 'country_of_residence', 'residential_address', 'user_feedback', 'review_count', 'submitted_at', 'reviewed_at'], excluded: ['provider', 'provider_reference', 'reviewer_notes', 'reason_code', 'reviewed_by', 'created_at', 'updated_at'] },
    ]
    for (const { table, granted, excluded } of expectations) {
      const columns = extractColumnGrant(sql, table)
      expect(columns, `${table}: missing column-level grant`).not.toBeNull()
      expect(columns?.sort()).toEqual([...granted].sort())
      for (const col of excluded) {
        expect(columns, `${table}: internal column "${col}" must never be granted`).not.toContain(col)
      }
    }
  })

  it('5. ad_packages gets an explicit column-level grant excluding created_by/is_test/is_active/updated_at', () => {
    const columns = extractColumnGrant(sql, 'ad_packages')
    expect(columns).not.toBeNull()
    expect(columns?.sort()).toEqual(
      ['id', 'name', 'inventory_class', 'placement_type', 'placement_tier', 'position_band', 'price_cents', 'currency', 'impression_quota', 'commercial_version', 'created_at'].sort()
    )
    for (const col of ['created_by', 'is_test', 'is_active', 'updated_at']) {
      expect(columns, `ad_packages: internal column "${col}" must never be granted`).not.toContain(col)
    }
  })

  it('6. each converted self/merchant table gets a new row-ownership RLS policy, scoped to authenticated only, matching the view\'s own filter', () => {
    const policies: Record<string, RegExp> = {
      listing_moderation: /create policy "listing_moderation: merchant read own"[\s\S]*?to authenticated[\s\S]*?using \(\s*exists \(\s*select 1 from public\.listings l\s*\n\s*where l\.id = listing_moderation\.listing_id and l\.merchant_id = auth\.uid\(\)\s*\)\s*\);/,
      listing_ownership_verification: /create policy "listing_ownership_verification: merchant read own"[\s\S]*?to authenticated[\s\S]*?using \(\s*exists \(\s*select 1 from public\.listings l\s*\n\s*where l\.id = listing_ownership_verification\.listing_id and l\.merchant_id = auth\.uid\(\)\s*\)\s*\);/,
      identity_verifications: /create policy "identity_verifications: self read own"[\s\S]*?to authenticated[\s\S]*?using \(auth\.uid\(\) = user_id\);/,
    }
    for (const [table, pattern] of Object.entries(policies)) {
      expect(sql, `${table}: missing or malformed ownership RLS policy`).toMatch(pattern)
    }
  })

  it('7. ad_packages gets a new public-read RLS policy scoped to anon and authenticated, matching the view\'s own filter exactly (is_active = true and is_test = false)', () => {
    expect(sql).toMatch(/create policy "ad_packages: public read active"[\s\S]*?to anon, authenticated[\s\S]*?using \(is_active = true and is_test = false\);/)
  })

  it('8. no new RLS policy or column grant touches the 4 retained (definer-exception) views\' own base tables -- barter_offer_items, barter_offers, barter_agreements, rent_to_buy_agreements, profiles, merchant_subscription_plans, merchant_subscription_history, barter_skill_task_posts', () => {
    const untouchedTables = [
      'barter_offer_items', 'barter_offers', 'barter_agreements', 'rent_to_buy_agreements',
      'profiles', 'merchant_subscription_plans', 'merchant_subscription_history', 'barter_skill_task_posts',
    ]
    for (const table of untouchedTables) {
      expect(codeOnly, `${table}: unexpected policy/grant change`).not.toMatch(new RegExp(`create policy[^;]*on public\\.${table}\\b`))
      expect(codeOnly, `${table}: unexpected column/table grant`).not.toMatch(new RegExp(`grant select[^;]* on public\\.${table}\\b`))
      expect(codeOnly, `${table}: unexpected revoke`).not.toMatch(new RegExp(`revoke all on public\\.${table}\\b`))
    }
  })

  it('9. every view-level grant matches the exact expected audience: authenticated only for views 1-3, anon+authenticated for 4-8', () => {
    const expectedAudience: Record<string, string> = {
      listing_moderation_merchant_view: 'authenticated',
      listing_ownership_verification_merchant_view: 'authenticated',
      identity_verification_self_view: 'authenticated',
      barter_locked_listings: 'anon, authenticated',
      rent_to_buy_locked_listings: 'anon, authenticated',
      public_profiles: 'anon, authenticated',
      barter_skill_task_public_posts: 'anon, authenticated',
      ad_packages_public: 'anon, authenticated',
    }
    for (const [name, audience] of Object.entries(expectedAudience)) {
      expect(sql, `${name}: view grant missing or audience mismatch`).toMatch(
        new RegExp(`grant select on public\\.${name} to ${audience.replace(/, /g, ',\\s*')};`)
      )
    }
  })

  it('10. no self/merchant view is ever granted to anon', () => {
    for (const name of ['listing_moderation_merchant_view', 'listing_ownership_verification_merchant_view', 'identity_verification_self_view']) {
      const grantMatch = sql.match(new RegExp(`grant select on public\\.${name} to ([^;]+);`))
      expect(grantMatch?.[1]).not.toMatch(/\banon\b/)
    }
  })

  it('11. no view or table in this migration is given INSERT/UPDATE/DELETE privileges or an INSTEAD OF trigger -- everything added remains read-only', () => {
    expect(codeOnly).not.toMatch(/grant (insert|update|delete)/i)
    expect(codeOnly).not.toMatch(/instead of/i)
    expect(codeOnly).not.toMatch(/create (or replace )?(trigger|function)/i)
  })

  it('12. no table-wide (unqualified) SELECT grant exists on any of the 4 converted base tables -- every grant to authenticated/anon on them is column-level', () => {
    for (const table of ['listing_moderation', 'listing_ownership_verification', 'identity_verifications', 'ad_packages']) {
      expect(codeOnly, `${table}: a bare table-wide grant exists -- expected column-level only`).not.toMatch(
        new RegExp(`grant select on public\\.${table} to`)
      )
    }
  })

  it('13. existing admin-only RLS policies on the 4 converted base tables are untouched -- no drop policy anywhere in this migration', () => {
    expect(codeOnly).not.toMatch(/drop policy/i)
  })

  it('14. this migration does not disable RLS on any table, and does not touch Support Centre or Intelligence objects', () => {
    expect(codeOnly).not.toMatch(/disable row level security/i)
    expect(codeOnly).not.toMatch(/support_case|support_centre|intelligence_evaluation|admin_intelligence/i)
  })

  it('15. no REVOKE narrows a role\'s access on the VIEW objects below their final, intended grant -- every revoke on a view is immediately followed by a re-grant to its own intended audience within this migration', () => {
    for (const name of ALL_VIEWS) {
      const hasRevoke = new RegExp(`revoke all on public\\.${name} from`).test(sql)
      const hasGrant = new RegExp(`grant select on public\\.${name} to`).test(sql)
      if (hasRevoke) {
        expect(hasGrant, `${name}: revoked but never re-granted in this migration`).toBe(true)
      }
    }
  })
})
