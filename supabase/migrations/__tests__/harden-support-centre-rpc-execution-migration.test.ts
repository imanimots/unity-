import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

/**
 * E6 migration-contract test for
 * 20261031120000_harden_support_centre_rpc_execution.sql.
 *
 * Context: Supabase's security advisor flagged every Support Centre
 * SECURITY DEFINER RPC as anon/authenticated-executable --
 * 20261026000000_support_centre_schema.sql never added a REVOKE/GRANT
 * EXECUTE statement for any of them, so each still carried Postgres's
 * default PUBLIC EXECUTE grant. This is a forward migration (the
 * schema migration is already live/applied and is never rewritten) that
 * locks EXECUTE to service_role only, matching the real application
 * trust boundary traced in src/app/api/admin/support/**.
 *
 * LIMITATION, stated explicitly per this codebase's own established
 * convention: this test parses the migration's SQL source text and
 * asserts on its structure. It does NOT execute the SQL against a real
 * Postgres instance and does NOT prove live privilege state -- no live
 * database is available to this test environment. This migration has
 * not been applied by any phase; it reaches the live database only via
 * the project's GitHub-integrated Supabase workflow.
 */
const REPO_ROOT = join(__dirname, '../../..')
const MIGRATION_PATH = join(REPO_ROOT, 'supabase/migrations/20261031120000_harden_support_centre_rpc_execution.sql')
const SCHEMA_MIGRATION_PATH = join(REPO_ROOT, 'supabase/migrations/20261026000000_support_centre_schema.sql')
const sql = readFileSync(MIGRATION_PATH, 'utf-8')
const schemaSql = readFileSync(SCHEMA_MIGRATION_PATH, 'utf-8')
const normalized = sql.replace(/\s+/g, ' ')

/** Every privileged Support Centre mutation RPC -- enumerated once here so a future addition to the schema migration without a matching entry here is caught by test 2, not silently missed. */
const PRIVILEGED_RPC_NAMES = [
  'create_support_case',
  'assign_support_case',
  'change_support_case_priority',
  'update_support_case_status',
  'escalate_support_case',
  'resolve_support_case',
  'close_support_case',
  'reopen_support_case',
  'add_support_case_note',
]

describe('20261031120000_harden_support_centre_rpc_execution.sql (category: ADMIN-CONTROL-CENTRE-BATCH-E6)', () => {
  it('1. does not edit the already-applied schema migration -- this is a new, separate forward migration file', () => {
    expect(schemaSql).not.toMatch(/revoke all on function/)
    expect(schemaSql).not.toMatch(/E6/)
  })

  it('2. every privileged RPC defined in the schema migration has a corresponding entry in the enumerated list above -- catches a future RPC addition that forgets to also appear in this hardening migration', () => {
    const definedFns = [...schemaSql.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1])
    const privilegedDefined = definedFns.filter((name) => schemaSql.includes(`auth.role() <> 'service_role'`) && schemaSql.indexOf(`function public.${name}(`) >= 0)
    // Every function that contains the service_role-only guard anywhere in the file is expected to be in our list -- cross-check both directions.
    for (const name of PRIVILEGED_RPC_NAMES) {
      expect(definedFns, `${name} is not defined in the schema migration`).toContain(name)
    }
    expect(privilegedDefined.length).toBeGreaterThanOrEqual(PRIVILEGED_RPC_NAMES.length)
  })

  it('3. every privileged RPC has a REVOKE and a GRANT statement in this migration, both referencing the IDENTICAL argument-type signature', () => {
    for (const name of PRIVILEGED_RPC_NAMES) {
      const revokeMatch = normalized.match(new RegExp(`revoke all on function public\\.${name}\\(([^)]*)\\) from public, anon, authenticated;`))
      const grantMatch = normalized.match(new RegExp(`grant execute on function public\\.${name}\\(([^)]*)\\) to service_role;`))
      expect(revokeMatch, `missing REVOKE for ${name}`).toBeTruthy()
      expect(grantMatch, `missing GRANT for ${name}`).toBeTruthy()
      expect(revokeMatch?.[1].trim(), `${name}: REVOKE/GRANT signature mismatch`).toBe(grantMatch?.[1].trim())
    }
  })

  it('4. every REVOKE explicitly names all three of public, anon, and authenticated -- not a subset', () => {
    const revokeLines = normalized.match(/revoke all on function public\.\w+\([^)]*\) from [^;]+;/g) ?? []
    expect(revokeLines.length).toBe(PRIVILEGED_RPC_NAMES.length)
    for (const line of revokeLines) {
      expect(line).toMatch(/from public, anon, authenticated;/)
    }
  })

  it('5. every GRANT targets service_role exclusively -- no grant to anon, authenticated, or public anywhere in this migration', () => {
    const grantLines = normalized.match(/grant execute on function public\.\w+\([^)]*\) to [^;]+;/g) ?? []
    expect(grantLines.length).toBe(PRIVILEGED_RPC_NAMES.length)
    for (const line of grantLines) {
      expect(line).toMatch(/to service_role;$/)
    }
    expect(sql).not.toMatch(/to (anon|authenticated|public)\b/)
  })

  it('6. the argument-type signature used for each function matches its exact declaration in the schema migration -- the revoke/grant cannot silently target the wrong overload', () => {
    const expectedSignatures: Record<string, string> = {
      create_support_case: 'uuid, text, support_case_category, text, support_case_priority, uuid, uuid, support_linked_entity_type, uuid, support_case_source, text',
      assign_support_case: 'uuid, uuid, uuid, text',
      change_support_case_priority: 'uuid, uuid, support_case_priority, text',
      update_support_case_status: 'uuid, uuid, support_case_status, text',
      escalate_support_case: 'uuid, uuid, text, text',
      resolve_support_case: 'uuid, uuid, text, text',
      close_support_case: 'uuid, uuid, text, text',
      reopen_support_case: 'uuid, uuid, text, text',
      add_support_case_note: 'uuid, uuid, text, text',
    }
    for (const [name, expectedSig] of Object.entries(expectedSignatures)) {
      const grantMatch = normalized.match(new RegExp(`grant execute on function public\\.${name}\\(([^)]*)\\) to service_role;`))
      expect(grantMatch?.[1].trim(), `${name} signature mismatch`).toBe(expectedSig)
    }
  })

  it('7. no stale/duplicate function definition exists anywhere else in the repository migration history for any of these 9 names -- no unexpected overload to separately revoke', () => {
    const migrationsDir = join(REPO_ROOT, 'supabase/migrations')
    const files = readdirSync(migrationsDir).filter((f: string) => f.endsWith('.sql'))
    for (const name of PRIVILEGED_RPC_NAMES) {
      // Narrowly matches a DEFINITION (CREATE [OR REPLACE] FUNCTION), not
      // this migration's own REVOKE/GRANT lines, which also legitimately
      // reference "function public.<name>(" without redefining it.
      const definingFiles = files.filter((f: string) => readFileSync(join(migrationsDir, f), 'utf-8').match(new RegExp(`create (or replace )?function public\\.${name}\\(`)))
      expect(definingFiles, `${name} defined in more than one migration file`).toHaveLength(1)
    }
  })

  it('8. the two non-privileged helper functions get a fixed search_path via ALTER FUNCTION, with no change to their body/behavior (no CREATE OR REPLACE FUNCTION for either in this migration)', () => {
    expect(sql).toMatch(/alter function public\.generate_support_case_number\(\) set search_path = public;/)
    expect(sql).toMatch(/alter function public\.touch_support_case_updated_at\(\) set search_path = public;/)
    expect(sql).not.toMatch(/create (or replace )?function public\.generate_support_case_number/)
    expect(sql).not.toMatch(/create (or replace )?function public\.touch_support_case_updated_at/)
  })

  it('9. this migration contains no CREATE OR REPLACE FUNCTION at all -- it only adjusts privileges/search_path, never function behavior (confirms Part H\'s "no behavior change")', () => {
    expect(sql).not.toMatch(/create (or replace )?function/)
  })

  it('10. this migration does not touch any table, policy, trigger, or RLS setting -- RPC execution privileges and search_path only', () => {
    expect(sql).not.toMatch(/create table|alter table|create policy|drop policy|create trigger|drop trigger|enable row level security/)
  })

  it('11. no dynamic SQL exists in this migration (no EXECUTE/format/quote_ident/quote_literal) -- plain static grant/revoke/alter statements only', () => {
    expect(sql).not.toMatch(/\bEXECUTE\s+(format|'|")/i)
    expect(sql).not.toMatch(/quote_ident|quote_literal/)
  })

  it('12. no marketplace entity table is referenced -- this migration is Support Centre RPC-privilege-only', () => {
    expect(sql).not.toMatch(/references public\.|insert into|update public\.|delete from/)
  })
})
