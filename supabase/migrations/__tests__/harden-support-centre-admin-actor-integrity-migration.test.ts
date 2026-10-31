import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

/**
 * E7 migration-contract test for
 * 20261031150000_harden_support_centre_admin_actor_integrity.sql.
 *
 * Context: E6 locked database EXECUTE privilege on all 9 privileged
 * Support Centre RPCs to service_role only. That is a separate control
 * from this migration's concern: INTERNAL ACTOR VALIDATION -- whether
 * the `p_admin_id` *value* passed into each function body is
 * independently re-confirmed, inside Postgres, to belong to a
 * `profiles` row with role = 'admin', rather than trusted as a bare
 * value from the calling application layer. Fresh re-trace of the
 * live, already-applied 20261026000000_support_centre_schema.sql
 * found only create_support_case already had this check; the other 8
 * did not (assign_support_case validated the wrong field -- the
 * assignee, not the actor).
 *
 * This is a forward migration (the schema migration is already
 * live/applied and is never rewritten) that redefines those 8
 * functions via CREATE OR REPLACE FUNCTION, adding the identical
 * actor-validation check create_support_case already used, in the
 * same position (immediately after the existing `p_admin_id is null`
 * check), and changing nothing else about any of the 8 bodies.
 *
 * LIMITATION, stated explicitly per this codebase's own established
 * convention: this test parses SQL source text and asserts on its
 * structure. It does NOT execute the SQL against a real Postgres
 * instance and does NOT prove live privilege or validation behavior --
 * no live database is available to this test environment. This
 * migration has not been applied by any phase; it reaches the live
 * database only via the project's GitHub-integrated Supabase workflow.
 */
const REPO_ROOT = join(__dirname, '../../..')
const MIGRATION_PATH = join(REPO_ROOT, 'supabase/migrations/20261031150000_harden_support_centre_admin_actor_integrity.sql')
const SCHEMA_MIGRATION_PATH = join(REPO_ROOT, 'supabase/migrations/20261026000000_support_centre_schema.sql')
const sql = readFileSync(MIGRATION_PATH, 'utf-8')
const schemaSql = readFileSync(SCHEMA_MIGRATION_PATH, 'utf-8')
const normalized = sql.replace(/\s+/g, ' ')

/** create_support_case already had the correct check at schema-migration time and is deliberately NOT redefined here -- nothing to fix. */
const REDEFINED_RPC_NAMES = [
  'assign_support_case',
  'change_support_case_priority',
  'update_support_case_status',
  'escalate_support_case',
  'resolve_support_case',
  'close_support_case',
  'reopen_support_case',
  'add_support_case_note',
]

const ACTOR_CHECK = `if not exists (select 1 from public.profiles where id = p_admin_id and role = 'admin') then raise exception 'not authorized'; end if;`

/** Extracts one function's full CREATE OR REPLACE FUNCTION ... $$; block from migration source text. */
function extractFunctionBlock(source: string, name: string): string {
  const startIdx = source.indexOf(`create or replace function public.${name}(`)
  if (startIdx === -1) throw new Error(`${name}: definition not found`)
  const endIdx = source.indexOf('\n$$;', startIdx)
  if (endIdx === -1) throw new Error(`${name}: terminating $$; not found`)
  return source.slice(startIdx, endIdx + '\n$$;'.length)
}

describe('20261031150000_harden_support_centre_admin_actor_integrity.sql (category: ADMIN-CONTROL-CENTRE-BATCH-E7)', () => {
  it('1. does not edit the already-applied schema migration file at all', () => {
    expect(schemaSql).not.toMatch(/E7/)
  })

  it('2. create_support_case is NOT redefined here -- it already had the correct actor check at schema-migration time', () => {
    expect(sql).not.toMatch(/create (or replace )?function public\.create_support_case\(/)
  })

  it('3. every one of the other 8 privileged RPCs is redefined via CREATE OR REPLACE FUNCTION with an unchanged argument-type signature', () => {
    const expectedSignatures: Record<string, string> = {
      assign_support_case: 'p_admin_id uuid,\n  p_case_id uuid,\n  p_assignee_admin_id uuid,\n  p_idempotency_key text default null',
      change_support_case_priority: 'p_admin_id uuid,\n  p_case_id uuid,\n  p_priority support_case_priority,\n  p_idempotency_key text default null',
      update_support_case_status: 'p_admin_id uuid,\n  p_case_id uuid,\n  p_target_status support_case_status,\n  p_idempotency_key text default null',
      escalate_support_case: 'p_admin_id uuid,\n  p_case_id uuid,\n  p_reason text,\n  p_idempotency_key text default null',
      resolve_support_case: 'p_admin_id uuid,\n  p_case_id uuid,\n  p_resolution_summary text,\n  p_idempotency_key text default null',
      close_support_case: 'p_admin_id uuid,\n  p_case_id uuid,\n  p_reason text default null,\n  p_idempotency_key text default null',
      reopen_support_case: 'p_admin_id uuid,\n  p_case_id uuid,\n  p_reason text,\n  p_idempotency_key text default null',
      add_support_case_note: 'p_admin_id uuid,\n  p_case_id uuid,\n  p_note text,\n  p_idempotency_key text default null',
    }
    for (const name of REDEFINED_RPC_NAMES) {
      expect(sql, `${name} not redefined`).toMatch(new RegExp(`create or replace function public\\.${name}\\(`))
      expect(schemaSql, `${name}: expected signature not found in schema migration -- test fixture is stale`).toContain(
        `create or replace function public.${name}(\n  ${expectedSignatures[name]}\n)`
      )
      expect(sql, `${name}: redefinition signature mismatch vs schema migration`).toContain(
        `create or replace function public.${name}(\n  ${expectedSignatures[name]}\n)`
      )
    }
  })

  it('4. every redefined function contains the admin-actor validation check, positioned immediately after the existing p_admin_id is null check and before every other check', () => {
    for (const name of REDEFINED_RPC_NAMES) {
      const block = extractFunctionBlock(sql, name).replace(/\s+/g, ' ')
      const nullCheckIdx = block.indexOf(`if p_admin_id is null then raise exception 'not authenticated'; end if;`)
      const actorCheckIdx = block.indexOf(ACTOR_CHECK)
      expect(nullCheckIdx, `${name}: missing p_admin_id is null check`).toBeGreaterThan(-1)
      expect(actorCheckIdx, `${name}: missing admin-actor validation check`).toBeGreaterThan(-1)
      expect(actorCheckIdx, `${name}: actor check must come immediately after the null check`).toBe(
        nullCheckIdx + `if p_admin_id is null then raise exception 'not authenticated'; end if;`.length + 1
      )
    }
  })

  it('5. the ONLY behavioral difference between each redefined function and its original schema-migration body is the inserted admin-actor check -- every other line is byte-for-byte identical', () => {
    for (const name of REDEFINED_RPC_NAMES) {
      const original = extractFunctionBlock(schemaSql, name)
      const updated = extractFunctionBlock(sql, name)
      const insertedBlockPattern = new RegExp(`\\n\\s*if not exists \\(select 1 from public\\.profiles where id = p_admin_id and role = 'admin'\\) then\\n\\s*raise exception 'not authorized';\\n\\s*end if;`)
      expect(updated, `${name}: inserted actor-check block not found in expected form`).toMatch(insertedBlockPattern)
      const updatedWithoutInsertedCheck = updated.replace(insertedBlockPattern, '')
      expect(updatedWithoutInsertedCheck, `${name}: a line other than the actor check differs from the original schema-migration body`).toBe(original)
    }
  })

  it('6. every redefined function retains "security definer set search_path = public" -- CREATE OR REPLACE must not silently drop it', () => {
    for (const name of REDEFINED_RPC_NAMES) {
      const block = extractFunctionBlock(sql, name)
      expect(block, `${name}: missing security definer`).toMatch(/security definer/)
      expect(block, `${name}: missing fixed search_path`).toMatch(/set search_path = public/)
    }
  })

  it('7. every redefined function still has its own auth.role() <> service_role guard, unchanged and not removed', () => {
    for (const name of REDEFINED_RPC_NAMES) {
      const block = extractFunctionBlock(sql, name)
      expect(block, `${name}: service_role guard missing`).toMatch(/auth\.role\(\) <> 'service_role'/)
    }
  })

  it('8. every redefined RPC has a REVOKE and a GRANT in this migration re-asserting the exact E6 service_role-only signature -- defense-in-depth re-enforcement, not a silent assumption that CREATE OR REPLACE preserved privileges', () => {
    const expectedSignatures: Record<string, string> = {
      assign_support_case: 'uuid, uuid, uuid, text',
      change_support_case_priority: 'uuid, uuid, support_case_priority, text',
      update_support_case_status: 'uuid, uuid, support_case_status, text',
      escalate_support_case: 'uuid, uuid, text, text',
      resolve_support_case: 'uuid, uuid, text, text',
      close_support_case: 'uuid, uuid, text, text',
      reopen_support_case: 'uuid, uuid, text, text',
      add_support_case_note: 'uuid, uuid, text, text',
    }
    for (const [name, sig] of Object.entries(expectedSignatures)) {
      const revokeMatch = normalized.match(new RegExp(`revoke all on function public\\.${name}\\(([^)]*)\\) from public, anon, authenticated;`))
      const grantMatch = normalized.match(new RegExp(`grant execute on function public\\.${name}\\(([^)]*)\\) to service_role;`))
      expect(revokeMatch, `${name}: missing REVOKE`).toBeTruthy()
      expect(grantMatch, `${name}: missing GRANT`).toBeTruthy()
      expect(revokeMatch?.[1].trim()).toBe(sig)
      expect(grantMatch?.[1].trim()).toBe(sig)
    }
  })

  it('9. no GRANT/REVOKE targets anon, authenticated, or public anywhere in this migration', () => {
    // Scoped to actual GRANT statements -- a broad "to (anon|authenticated|public)"
    // substring search false-positives on unrelated SQL like "insert into
    // public.support_case_history" (the word "into" itself ends in "to").
    const grantLines = normalized.match(/grant execute on function public\.\w+\([^)]*\) to [^;]+;/g) ?? []
    expect(grantLines.length).toBe(REDEFINED_RPC_NAMES.length)
    for (const line of grantLines) {
      expect(line).toMatch(/to service_role;$/)
    }
  })

  it('10. this migration does not touch any table, policy, trigger, RLS setting, or the two non-privileged helper functions', () => {
    expect(sql).not.toMatch(/create table|alter table|create policy|drop policy|create trigger|drop trigger|enable row level security/)
    expect(sql).not.toMatch(/generate_support_case_number|touch_support_case_updated_at/)
  })

  it('11. no dynamic SQL exists in this migration (no EXECUTE/format/quote_ident/quote_literal)', () => {
    expect(sql).not.toMatch(/\bEXECUTE\s+(format|'|")/i)
    expect(sql).not.toMatch(/quote_ident|quote_literal/)
  })

  it('12. the new exception message is the identical literal string the service_role guard already uses -- no new error-mapping surface is introduced at the route level', () => {
    const messages = [...sql.matchAll(/raise exception '([^']+)'/g)].map((m) => m[1])
    expect(new Set(messages).has('not authorized')).toBe(true)
    // every message raised anywhere in this migration must already be one the existing route-level error mapping (from the schema migration's own original messages) knows how to handle
    for (const message of messages) {
      expect(schemaSql, `"${message}" is a new exception message not already present in the schema migration`).toContain(`'${message}'`)
    }
  })

  it('13. no RPC name in this migration is absent from the schema migration -- no new/renamed function introduced', () => {
    const migrationsDir = join(REPO_ROOT, 'supabase/migrations')
    const allFiles = readdirSync(migrationsDir).filter((f: string) => f.endsWith('.sql'))
    expect(allFiles).toContain('20261031150000_harden_support_centre_admin_actor_integrity.sql')
    const definedHere = [...sql.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1])
    expect(definedHere.sort()).toEqual([...REDEFINED_RPC_NAMES].sort())
  })
})
