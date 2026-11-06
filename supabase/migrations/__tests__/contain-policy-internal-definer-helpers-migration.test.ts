import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * E15 migration-contract test for
 * 20261104090000_contain_policy_internal_definer_helpers.sql.
 *
 * Scope: the three policy-only, one-argument participant-helper
 * overloads (is_barter_contribution_participant(uuid),
 * is_dispute_participant(uuid), is_message_participant(uuid)) move
 * from public to a new, non-Data-API-exposed `private` schema. The
 * two-argument, service_role-only overloads (still required by 3
 * existing .rpc() callers) are NOT touched -- they remain in public.
 * All 6 dependent RLS policies are repointed to the new schema.
 *
 * A pre-write check against the live 20261101090000 migration source
 * confirmed all 6 policies (including dispute_history) were already
 * correctly pointed at the one-argument overload -- there is no policy
 * defect being corrected here, only a schema relocation.
 *
 * LIMITATION, per this codebase's established convention: this test
 * parses SQL source text and asserts on its structure. It does not
 * execute against a live Postgres instance and cannot literally prove
 * live EXECUTE/RLS enforcement. This migration reaches the live
 * database only via the project's GitHub-integrated Supabase workflow.
 */
const REPO_ROOT = join(__dirname, '../../..')
const MIGRATION_PATH = join(REPO_ROOT, 'supabase/migrations/20261104090000_contain_policy_internal_definer_helpers.sql')
const SOURCE_PATH = join(REPO_ROOT, 'supabase/migrations/20261101090000_harden_privileged_rpc_callability.sql')
const sql = readFileSync(MIGRATION_PATH, 'utf-8')
const source = readFileSync(SOURCE_PATH, 'utf-8')
const normalized = sql.replace(/\s+/g, ' ')

function stripComments(src: string): string {
  return src.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')
}
const codeOnly = stripComments(sql)

function extractFunctionBody(src: string, schema: string, name: string): string {
  const defIdx = src.search(new RegExp(`create or replace function ${schema}\\.${name}\\(`))
  if (defIdx === -1) throw new Error(`${schema}.${name}: definition not found`)
  const startIdx = src.indexOf('as $$', defIdx)
  const endIdx = src.indexOf('$$;', startIdx + 5)
  return src.slice(startIdx + 5, endIdx).trim()
}

const HELPERS = ['is_barter_contribution_participant', 'is_dispute_participant', 'is_message_participant']

describe('20261104090000_contain_policy_internal_definer_helpers.sql (category: ADMIN-CONTROL-CENTRE-BATCH-E15)', () => {
  it('1. creates the private schema and locks down its default access before granting anything', () => {
    expect(codeOnly).toMatch(/create schema if not exists private;/)
    const createIdx = codeOnly.indexOf('create schema if not exists private;')
    const revokeIdx = codeOnly.indexOf('revoke all on schema private from public;')
    const grantIdx = codeOnly.indexOf('grant usage on schema private to authenticated;')
    expect(revokeIdx, 'missing REVOKE ALL on schema private from public').toBeGreaterThan(createIdx)
    expect(grantIdx, 'missing GRANT USAGE on schema private to authenticated').toBeGreaterThan(revokeIdx)
  })

  it('2. never grants USAGE on the private schema to anon or CREATE to anyone', () => {
    expect(codeOnly).not.toMatch(/grant\s+usage\s+on\s+schema\s+private\s+to\s+[^;]*\banon\b/)
    expect(codeOnly).not.toMatch(/grant\s+create\s+on\s+schema\s+private/)
  })

  it('3. each one-argument helper is redefined in the private schema with an unchanged body and no caller-supplied subject', () => {
    for (const name of HELPERS) {
      expect(normalized, `${name}: not defined in private`).toMatch(new RegExp(`create or replace function private\\.${name}\\(p_\\w+ uuid\\)\\s*returns boolean`))
      const privateBody = extractFunctionBody(sql, 'private', name)
      const publicBody = extractFunctionBody(source, 'public', name)
      expect(privateBody, `${name}: body diverges from the live public one-argument body`).toBe(publicBody)
      expect(privateBody, `${name}: must never reference p_user_id`).not.toMatch(/p_user_id/)
    }
  })

  it('4. each relocated helper pins search_path to the empty string and keeps security definer', () => {
    for (const name of HELPERS) {
      const defIdx = sql.search(new RegExp(`create or replace function private\\.${name}\\(`))
      const header = sql.slice(defIdx, sql.indexOf('as $$', defIdx))
      expect(header, `${name}: missing security definer`).toMatch(/security definer/)
      expect(header, `${name}: expected empty search_path`).toMatch(/set search_path = ''/)
    }
  })

  it('5. each relocated helper grants EXECUTE only to authenticated, with public/anon explicitly revoked', () => {
    for (const name of HELPERS) {
      expect(normalized).toMatch(new RegExp(`revoke all on function private\\.${name}\\(uuid\\) from public, anon;`))
      expect(normalized).toMatch(new RegExp(`grant execute on function private\\.${name}\\(uuid\\) to authenticated;`))
      const grantLines = normalized.match(new RegExp(`grant execute on function private\\.${name}\\(uuid\\) to [^;]+;`, 'g')) ?? []
      expect(grantLines).toHaveLength(1)
      expect(grantLines[0]).toMatch(/to authenticated;$/)
    }
  })

  it('6. the old public one-argument overloads are dropped, without CASCADE', () => {
    for (const name of HELPERS) {
      expect(codeOnly).toMatch(new RegExp(`drop function if exists public\\.${name}\\(uuid\\);`))
    }
    expect(codeOnly).not.toMatch(/cascade/i)
  })

  it('7. the two-argument overloads are never redefined, dropped, or re-granted in this migration -- untouched', () => {
    for (const name of HELPERS) {
      expect(codeOnly, `${name}: two-argument overload unexpectedly redefined`).not.toMatch(
        new RegExp(`create or replace function (public|private)\\.${name}\\(p_\\w+ uuid, p_user_id uuid\\)`)
      )
      expect(codeOnly, `${name}: two-argument overload unexpectedly dropped`).not.toMatch(
        new RegExp(`drop function[^;]*${name}\\(uuid,\\s*uuid\\)`)
      )
      expect(codeOnly, `${name}: two-argument overload unexpectedly re-granted/revoked`).not.toMatch(
        new RegExp(`(grant|revoke)[^;]*${name}\\(uuid,\\s*uuid\\)`)
      )
    }
  })

  it('8. all 6 dependent RLS policies are redefined to call the private, one-argument overload', () => {
    const policies: Array<{ name: string; table: string; pattern: RegExp }> = [
      { name: 'barter_contribution_details: participants read', table: 'barter_contribution_details', pattern: /using \(private\.is_barter_contribution_participant\(offer_item_id\)\);/ },
      { name: 'barter_contribution_milestones: participants read', table: 'barter_contribution_milestones', pattern: /using \(private\.is_barter_contribution_participant\(offer_item_id\)\);/ },
      { name: 'barter_milestone_evidence: participants read', table: 'barter_milestone_evidence', pattern: /using \(private\.is_barter_contribution_participant\(\s*\(select offer_item_id from public\.barter_contribution_milestones where id = milestone_id\)\s*\)\);/ },
      { name: 'dispute_history: parties read', table: 'dispute_history', pattern: /using \(private\.is_dispute_participant\(dispute_id\)\);/ },
      { name: 'dispute_evidence: parties read', table: 'dispute_evidence', pattern: /using \(private\.is_dispute_participant\(dispute_id\)\);/ },
      { name: 'message_attachments: parties read', table: 'message_attachments', pattern: /using \(private\.is_message_participant\(message_id\)\);/ },
    ]
    for (const { name, table, pattern } of policies) {
      expect(sql, `${name}: missing DROP POLICY IF EXISTS`).toMatch(new RegExp(`drop policy if exists "${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" on public\\.${table};`))
      const createIdx = sql.indexOf(`create policy "${name}"`)
      expect(createIdx, `${name}: missing CREATE POLICY`).toBeGreaterThan(-1)
      const terminatorIdx = sql.indexOf(';', createIdx)
      const window = sql.slice(createIdx, terminatorIdx + 1)
      expect(window, `${name}: policy predicate does not call the private, one-argument form`).toMatch(pattern)
      expect(window).not.toMatch(/is_\w+_participant\([^)]*,\s*auth\.uid\(\)\)/)
      expect(window).not.toMatch(/public\.is_\w+_participant/)
    }
    const dropPolicyLines = codeOnly.match(/drop policy if exists [^\n]+/g) ?? []
    expect(dropPolicyLines).toHaveLength(6)
  })

  it('9. no policy anywhere still references the public schema-qualified helper after relocation', () => {
    for (const name of HELPERS) {
      expect(codeOnly).not.toMatch(new RegExp(`using \\([^)]*public\\.${name}`))
    }
  })

  it('10. no table grant is added or widened, and no unrelated RLS enable/disable statement exists', () => {
    expect(codeOnly).not.toMatch(/grant\s+(select|insert|update|delete|all)\s+on\s+table/i)
    expect(codeOnly).not.toMatch(/enable row level security|disable row level security|create table|drop table|create trigger|drop trigger/)
  })

  it('11. no dynamic SQL exists anywhere in this migration', () => {
    expect(codeOnly).not.toMatch(/\bEXECUTE\s+(format|'|")/i)
    expect(codeOnly).not.toMatch(/quote_ident|quote_literal/)
  })

  it('12. this migration does not touch extension relocation, intelligence evaluation, or security_definer_view objects from prior phases', () => {
    expect(codeOnly).not.toMatch(/alter extension|pg_advisory_xact_lock|security_definer_view|public_profiles|barter_locked_listings|rent_to_buy_locked_listings|barter_skill_task_public_posts|match_knowledge_base/i)
  })

  it('13. this migration never grants anything to service_role (service_role bypasses grants/RLS and needs none of these new objects)', () => {
    expect(codeOnly).not.toMatch(/to\s+service_role/)
  })
})
