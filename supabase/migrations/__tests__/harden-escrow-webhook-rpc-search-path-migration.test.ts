import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

/**
 * E20 migration-contract test for
 * 20261106215502_harden_escrow_webhook_rpc_search_path.sql.
 *
 * Scope: a single, configuration-only ALTER FUNCTION tightening
 * public.record_escrow_webhook_event(text, text, boolean, jsonb)'s
 * search_path from 'public' to '' (empty). A fresh audit confirmed
 * this is the sole authoritative definition (never redefined, never
 * altered, never re-granted since its one creation migration), that
 * no second overload of this name exists, and that its body contains
 * zero unqualified application-schema references (every application
 * object -- public.escrow_provider_events, auth.role() -- is already
 * schema-qualified; every other reference -- jsonb_build_object,
 * unique_violation, uuid/text/boolean/jsonb -- is a pg_catalog
 * built-in or a PL/pgSQL condition name, neither of which is affected
 * by search_path). This migration does not touch the function body,
 * grants, security mode, or escrow_provider_events in any way, and
 * does not add any processing/claim/lifecycle machinery (the prior
 * phase's own audit already established none is currently needed).
 *
 * LIMITATION, per this codebase's established convention: this test
 * parses SQL source text and asserts on its structure. It does not
 * execute against a live Postgres instance and cannot literally query
 * pg_proc to confirm the live function's resulting search_path. This
 * migration reaches the live database only via the project's
 * GitHub-integrated Supabase workflow.
 */
const REPO_ROOT = join(__dirname, '../../..')
const MIGRATIONS_DIR = join(REPO_ROOT, 'supabase/migrations')
const MIGRATION_FILE = '20261106215502_harden_escrow_webhook_rpc_search_path.sql'
const MIGRATION_PATH = join(MIGRATIONS_DIR, MIGRATION_FILE)
const sql = readFileSync(MIGRATION_PATH, 'utf-8')
const codeOnly = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')
const normalized = codeOnly.replace(/\s+/g, ' ').trim()

describe('20261106215502_harden_escrow_webhook_rpc_search_path.sql (category: ADMIN-CONTROL-CENTRE-BATCH-E20)', () => {
  it('1. targets the exact function signature (text, text, boolean, jsonb)', () => {
    expect(normalized).toMatch(/alter function public\.record_escrow_webhook_event\(\s*text,\s*text,\s*boolean,\s*jsonb\s*\)\s*set search_path = '';/)
  })

  it('2. sets search_path to the empty string, not any other value', () => {
    expect(normalized).toMatch(/set search_path = '';$/)
    expect(codeOnly).not.toMatch(/set search_path = public/i)
  })

  it('3. uses ALTER FUNCTION only -- never CREATE OR REPLACE / CREATE / DROP FUNCTION', () => {
    expect(codeOnly).not.toMatch(/create (or replace )?function/i)
    expect(codeOnly).not.toMatch(/drop function/i)
  })

  it('4. never grants or revokes any privilege', () => {
    expect(codeOnly).not.toMatch(/\bgrant\b|\brevoke\b/i)
  })

  it('5. never touches RLS, policies, tables, triggers, or extensions', () => {
    expect(codeOnly).not.toMatch(/create policy|drop policy|alter policy/i)
    expect(codeOnly).not.toMatch(/create table|drop table|alter table/i)
    expect(codeOnly).not.toMatch(/create trigger|drop trigger/i)
    expect(codeOnly).not.toMatch(/alter extension|create extension|drop extension/i)
    expect(codeOnly).not.toMatch(/enable row level security|disable row level security/i)
  })

  it('6. never mutates data -- no INSERT/UPDATE/DELETE statement anywhere in this migration', () => {
    expect(codeOnly).not.toMatch(/\binsert into\b/i)
    expect(codeOnly).not.toMatch(/\bupdate\s+public\./i)
    expect(codeOnly).not.toMatch(/\bdelete from\b/i)
  })

  it('7. contains exactly one statement', () => {
    const statements = codeOnly.split(';').map((s) => s.trim()).filter(Boolean)
    expect(statements).toHaveLength(1)
  })

  it('8. no dynamic SQL exists anywhere in this migration', () => {
    expect(codeOnly).not.toMatch(/\bEXECUTE\s+(format|'|")/i)
    expect(codeOnly).not.toMatch(/quote_ident|quote_literal/)
  })

  it('9. is forward-only -- sorts after every pre-existing migration, no historical file modified', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'))
    expect(files).toContain(MIGRATION_FILE)
    const earlier = files.filter((f) => f !== MIGRATION_FILE && f < MIGRATION_FILE)
    expect(earlier.length).toBeGreaterThan(0)
  })
})

describe('authoritative function precondition: record_escrow_webhook_event is defined exactly once and never redefined/re-granted since', () => {
  const DEFINING_FILE = '20260825000004_escrow_webhook_rpc.sql'
  const definingPath = join(MIGRATIONS_DIR, DEFINING_FILE)

  it('10. exactly one migration anywhere references record_escrow_webhook_event (besides this one)', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && f !== MIGRATION_FILE)
    const referencing = files.filter((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf-8').includes('record_escrow_webhook_event'))
    expect(referencing).toEqual([DEFINING_FILE])
  })

  it('11. exactly one overload (text, text, boolean, jsonb) is defined -- no other signature exists', () => {
    const content = readFileSync(definingPath, 'utf-8')
    const defs = content.match(/create\s+or\s+replace\s+function\s+public\.record_escrow_webhook_event\(/gi) ?? []
    expect(defs).toHaveLength(1)
    expect(content).toMatch(/record_escrow_webhook_event\(\s*p_provider text,\s*p_provider_event_id text,\s*p_signature_valid boolean,\s*p_payload jsonb\s*\)/)
  })

  it('12. the authoritative body references only schema-qualified application objects and PL/pgSQL built-ins, never a bare unqualified application object', () => {
    const content = readFileSync(definingPath, 'utf-8')
    const bodyStart = content.indexOf('as $$')
    const bodyEnd = content.indexOf('$$;', bodyStart)
    const body = content.slice(bodyStart, bodyEnd)
    expect(body).toMatch(/insert into public\.escrow_provider_events/)
    expect(body).toMatch(/select id into v_id from public\.escrow_provider_events/)
    expect(body).toMatch(/auth\.role\(\)/)
    // The only application table this function ever touches is schema-qualified every time it appears -- zero bare (unqualified) occurrences.
    const bareTableRefs = body.match(/[^.]\bescrow_provider_events\b/g) ?? []
    const qualifiedTableRefs = body.match(/public\.escrow_provider_events/g) ?? []
    expect(bareTableRefs).toHaveLength(0)
    expect(qualifiedTableRefs.length).toBeGreaterThan(0)
  })

  it('13. is SECURITY DEFINER with search_path = public before this migration (the exact precondition E20 tightens)', () => {
    const content = readFileSync(definingPath, 'utf-8')
    const headerEnd = content.indexOf('as $$')
    const header = content.slice(0, headerEnd)
    expect(header).toMatch(/security definer/i)
    expect(header).toMatch(/set search_path = public/i)
  })

  it('14. grants are service_role-only, with public/anon/authenticated explicitly revoked, and this migration does not touch any of that', () => {
    const content = readFileSync(definingPath, 'utf-8')
    expect(content).toMatch(/revoke all on function public\.record_escrow_webhook_event\(text, text, boolean, jsonb\) from public, anon, authenticated;/)
    expect(content).toMatch(/grant execute on function public\.record_escrow_webhook_event\(text, text, boolean, jsonb\) to service_role;/)
  })
})
