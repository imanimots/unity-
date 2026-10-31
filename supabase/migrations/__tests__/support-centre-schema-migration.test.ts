import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * E5-F1 migration-contract test for
 * 20261026000000_support_centre_schema.sql.
 *
 * Context: live production evidence (the GitHub-integrated Supabase
 * migration workflow) proved this migration was being reconciled
 * against a database where its objects already exist -- it failed with
 * `policy "support_cases: admin read" ... already exists` (SQLSTATE
 * 42710), after the earlier CREATE TYPE/SEQUENCE/TABLE/INDEX statements
 * (already idempotent) silently succeeded as no-ops. Postgres has no
 * `CREATE POLICY IF NOT EXISTS` form, so every CREATE POLICY in this
 * file needs its own `DROP POLICY IF EXISTS` immediately before it.
 *
 * LIMITATION, stated explicitly per this codebase's own established
 * convention: this test parses the migration's SQL source text and
 * asserts on its structure. It does NOT execute the SQL against a real
 * Postgres instance -- no live database is available to this test
 * environment. This migration is still not applied by any phase; it
 * only reaches the live database via the project's GitHub-integrated
 * Supabase workflow.
 */
const REPO_ROOT = join(__dirname, '../../..')
const MIGRATION_PATH = join(REPO_ROOT, 'supabase/migrations/20261026000000_support_centre_schema.sql')
const sql = readFileSync(MIGRATION_PATH, 'utf-8')

describe('20261026000000_support_centre_schema.sql rerun-safety (category: ADMIN-CONTROL-CENTRE-BATCH-E5-F1)', () => {
  it('1. every CREATE POLICY statement is immediately preceded by a matching DROP POLICY IF EXISTS on the same table -- structural, so a future non-idempotent policy addition in this file fails this test too, not just a one-off check of the policy that happened to fail live', () => {
    const policyMatches = [...sql.matchAll(/create policy "([^"]+)"\s*\n\s*on public\.(\w+)/g)]
    expect(policyMatches.length).toBeGreaterThan(0)
    for (const match of policyMatches) {
      const [, policyName, tableName] = match
      const createIdx = match.index ?? 0
      const precedingWindow = sql.slice(Math.max(0, createIdx - 400), createIdx)
      const escapedName = policyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      expect(precedingWindow, `CREATE POLICY "${policyName}" on ${tableName} has no preceding DROP POLICY IF EXISTS`).toMatch(
        new RegExp(`drop policy if exists "${escapedName}" on public\\.${tableName}`)
      )
    }
  })

  it('2. exactly 3 CREATE POLICY statements exist (support_cases, support_case_notes, support_case_history admin-read) -- confirms all three known-affected policies were addressed, not merely the one that failed live', () => {
    const policyMatches = sql.match(/create policy "[^"]+"/g) ?? []
    expect(policyMatches).toHaveLength(3)
    expect(policyMatches).toEqual([
      'create policy "support_cases: admin read"',
      'create policy "support_case_notes: admin read"',
      'create policy "support_case_history: admin read"',
    ])
  })

  it('3. every CREATE TRIGGER statement is still preceded by a matching DROP TRIGGER IF EXISTS (unchanged, already-safe pattern -- regression guard)', () => {
    const triggerMatches = [...sql.matchAll(/create trigger (\w+)\s*\n\s*(?:before|after)[\s\S]*?on public\.(\w+)/g)]
    expect(triggerMatches.length).toBeGreaterThan(0)
    for (const match of triggerMatches) {
      const [, triggerName, tableName] = match
      const createIdx = match.index ?? 0
      const precedingWindow = sql.slice(Math.max(0, createIdx - 200), createIdx)
      expect(precedingWindow, `CREATE TRIGGER ${triggerName} on ${tableName} has no preceding DROP TRIGGER IF EXISTS`).toMatch(
        new RegExp(`drop trigger if exists ${triggerName} on public\\.${tableName}`)
      )
    }
  })

  it('4. every enum/type creation is exception-guarded against duplicate_object (already-safe pattern -- regression guard)', () => {
    const typeBlocks = sql.match(/do \$\$ begin\s*\n\s*create type [\s\S]*?end \$\$;/g) ?? []
    expect(typeBlocks.length).toBe(5)
    for (const block of typeBlocks) {
      expect(block).toMatch(/exception when duplicate_object then null/)
    }
  })

  it('5. the sequence and every index use IF NOT EXISTS (already-safe pattern -- regression guard)', () => {
    expect(sql).toMatch(/create sequence if not exists public\.support_case_number_seq/)
    const indexStatements = sql.match(/create index [^\n]+/g) ?? []
    expect(indexStatements.length).toBeGreaterThan(0)
    for (const stmt of indexStatements) {
      expect(stmt).toMatch(/create index if not exists/)
    }
  })

  it('6. every table creation uses IF NOT EXISTS (already-safe pattern -- regression guard)', () => {
    const tableStatements = sql.match(/create table [^\n(]+/g) ?? []
    expect(tableStatements.length).toBe(3)
    for (const stmt of tableStatements) {
      expect(stmt).toMatch(/create table if not exists/)
    }
  })

  it('7. every function uses CREATE OR REPLACE, never a bare CREATE FUNCTION that would fail on rerun', () => {
    expect(sql).not.toMatch(/create function /)
    const fnStatements = sql.match(/create (or replace )?function public\.\w+/g) ?? []
    expect(fnStatements.length).toBeGreaterThanOrEqual(10) // generate_support_case_number + touch_updated_at + 9 RPCs
    for (const stmt of fnStatements) {
      expect(stmt).toMatch(/create or replace function/)
    }
  })

  it('8. no standalone ALTER TABLE ADD CONSTRAINT exists -- all constraints are inline within the IF-NOT-EXISTS-guarded CREATE TABLE statements, so there is no separately-non-idempotent constraint statement to worry about', () => {
    expect(sql).not.toMatch(/alter table[\s\S]{0,60}add constraint/)
  })

  it('9. business semantics are unchanged -- case statuses, priorities, categories, and RPC set remain exactly as originally specified (this phase repairs rerun-safety only, not a Support Centre redesign)', () => {
    expect(sql).toMatch(/create type support_case_status as enum \(\s*\n?\s*'open', 'in_progress', 'waiting_on_user', 'escalated', 'resolved', 'closed'/)
    expect(sql).toMatch(/create type support_case_priority as enum \('low', 'normal', 'high', 'urgent'\)/)
    const rpcNames = [
      'create_support_case', 'assign_support_case', 'change_support_case_priority',
      'update_support_case_status', 'escalate_support_case', 'resolve_support_case',
      'close_support_case', 'reopen_support_case', 'add_support_case_note',
    ]
    for (const name of rpcNames) {
      expect(sql).toMatch(new RegExp(`create or replace function public\\.${name}\\(`))
    }
  })

  it('10. no GRANT/REVOKE statement was added -- this phase does not alter Support Centre privileges, only policy/trigger rerun-safety', () => {
    expect(sql).not.toMatch(/^\s*(grant|revoke)\s/m)
  })
})
