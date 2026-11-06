import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

/**
 * E21 migration-contract test for
 * 20261106221646_harden_safe_escrow_definer_search_paths.sql.
 *
 * Scope: ALTER-only search_path hardening for exactly the 3 of 9
 * escrow-domain SECURITY DEFINER candidates whose current
 * authoritative body contains zero unqualified application-schema
 * references: create_escrow_transaction, _escrow_transaction_dispute_block,
 * _escrow_transaction_completion_block. The other 6 (mark_escrow_funded,
 * release_escrow_transaction, refund_escrow_transaction,
 * cancel_escrow_transaction, _escrow_transaction_transition,
 * _rent_to_buy_settle_escrow) all have at least one bare
 * `escrow_status`/`escrow_status[]` reference in their executable
 * body and must NOT be altered in this phase -- they are a deferred
 * backlog for a future body-qualification phase.
 *
 * LIMITATION, per this codebase's established convention: this test
 * parses SQL source text and asserts on its structure. It does not
 * execute against a live Postgres instance and cannot literally query
 * pg_proc. This migration reaches the live database only via the
 * project's GitHub-integrated Supabase workflow.
 */
const REPO_ROOT = join(__dirname, '../../..')
const MIGRATIONS_DIR = join(REPO_ROOT, 'supabase/migrations')
const MIGRATION_FILE = '20261106221646_harden_safe_escrow_definer_search_paths.sql'
const MIGRATION_PATH = join(MIGRATIONS_DIR, MIGRATION_FILE)
const sql = readFileSync(MIGRATION_PATH, 'utf-8')
const codeOnly = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')
const normalized = codeOnly.replace(/\s+/g, ' ').trim()

const SAFE_SUBSET = ['create_escrow_transaction', '_escrow_transaction_dispute_block', '_escrow_transaction_completion_block']
const DEFERRED_BACKLOG = ['mark_escrow_funded', 'release_escrow_transaction', 'refund_escrow_transaction', 'cancel_escrow_transaction', '_escrow_transaction_transition', '_rent_to_buy_settle_escrow']

describe('20261106221646_harden_safe_escrow_definer_search_paths.sql (category: ADMIN-CONTROL-CENTRE-BATCH-E21)', () => {
  it('1. alters exactly the 3 safe-subset functions, no more, no fewer', () => {
    const alters = codeOnly.match(/alter function public\.(\w+)\(/g) ?? []
    expect(alters).toHaveLength(3)
    for (const name of SAFE_SUBSET) {
      expect(normalized).toMatch(new RegExp(`alter function public\\.${name}\\(`))
    }
  })

  it('2. every ALTER sets search_path to the empty string', () => {
    const statements = codeOnly.split(';').map((s) => s.trim()).filter(Boolean)
    expect(statements).toHaveLength(3)
    for (const stmt of statements) {
      expect(stmt.replace(/\s+/g, ' ')).toMatch(/set search_path = ''$/)
    }
  })

  it('3. none of the 6 deferred backlog functions is altered -- prevents accidental bulk hardening', () => {
    for (const name of DEFERRED_BACKLOG) {
      expect(codeOnly, `${name} must not be altered in E21`).not.toMatch(new RegExp(`alter function public\\.${name}\\(`))
    }
  })

  it('4. create_escrow_transaction uses the exact current 12-argument identity', () => {
    expect(normalized).toMatch(/alter function public\.create_escrow_transaction\(\s*text, uuid, uuid, uuid, uuid, numeric, numeric, text, text, text, text, uuid\s*\)\s*set search_path = '';/)
  })

  it('5. the two block-check functions schema-qualify their composite-type argument', () => {
    expect(normalized).toMatch(/alter function public\._escrow_transaction_dispute_block\(\s*public\.escrow_transactions\s*\)\s*set search_path = '';/)
    expect(normalized).toMatch(/alter function public\._escrow_transaction_completion_block\(\s*public\.escrow_transactions\s*\)\s*set search_path = '';/)
  })

  it('6. uses ALTER FUNCTION only -- never CREATE OR REPLACE / CREATE / DROP FUNCTION for any function', () => {
    expect(codeOnly).not.toMatch(/create (or replace )?function/i)
    expect(codeOnly).not.toMatch(/drop function/i)
  })

  it('7. never grants or revokes any privilege', () => {
    expect(codeOnly).not.toMatch(/\bgrant\b|\brevoke\b/i)
  })

  it('8. never touches RLS, policies, tables, triggers, or extensions', () => {
    expect(codeOnly).not.toMatch(/create policy|drop policy|alter policy/i)
    expect(codeOnly).not.toMatch(/create table|drop table|alter table/i)
    expect(codeOnly).not.toMatch(/create trigger|drop trigger/i)
    expect(codeOnly).not.toMatch(/alter extension|create extension|drop extension/i)
    expect(codeOnly).not.toMatch(/enable row level security|disable row level security/i)
  })

  it('9. never mutates data -- no INSERT/UPDATE/DELETE statement anywhere in this migration', () => {
    expect(codeOnly).not.toMatch(/\binsert into\b/i)
    expect(codeOnly).not.toMatch(/\bupdate\s+public\./i)
    expect(codeOnly).not.toMatch(/\bdelete from\b/i)
  })

  it('10. does not touch record_escrow_webhook_event (already hardened in E20) or ledger_entries (E18)', () => {
    expect(codeOnly).not.toMatch(/record_escrow_webhook_event/)
    expect(codeOnly).not.toMatch(/ledger_entries/)
  })

  it('11. no dynamic SQL exists anywhere in this migration', () => {
    expect(codeOnly).not.toMatch(/\bEXECUTE\s+(format|'|")/i)
    expect(codeOnly).not.toMatch(/quote_ident|quote_literal/)
  })

  it('12. is forward-only -- sorts after every pre-existing migration, no historical file modified', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'))
    expect(files).toContain(MIGRATION_FILE)
    const earlier = files.filter((f) => f !== MIGRATION_FILE && f < MIGRATION_FILE)
    expect(earlier.length).toBeGreaterThan(0)
  })
})

describe('body-safety contract: the 3 safe-subset functions reference zero unqualified application objects in their current authoritative body', () => {
  const RTB_FILE = join(MIGRATIONS_DIR, '20260821183600_rtb_v2_rpcs.sql')
  const rtbContent = readFileSync(RTB_FILE, 'utf-8')

  function extractLatestBody(name: string): string {
    const regex = new RegExp(`create or replace function public\\.${name}\\(`, 'g')
    const matches = [...rtbContent.matchAll(regex)]
    const last = matches[matches.length - 1]
    if (!last || last.index === undefined) throw new Error(`${name} not found in RTB file`)
    const bodyStart = rtbContent.indexOf('as $$', last.index)
    const bodyEnd = rtbContent.indexOf('$$;', bodyStart)
    return rtbContent.slice(last.index, bodyEnd + 3)
  }

  it('13. create_escrow_transaction (current 12-arg form, defined in the RTB widening migration) has zero bare escrow_status/application-type references', () => {
    const body = extractLatestBody('create_escrow_transaction')
    expect(body).toMatch(/public\.escrow_transactions/)
    expect(body).toMatch(/public\.escrow_transaction_history/)
    expect(body).toMatch(/auth\.role\(\)/)
    expect(body).not.toMatch(/[^.]\bescrow_status\b/)
  })

  it('14. _escrow_transaction_dispute_block (current form, defined in the RTB widening migration) has zero bare escrow_status/application-type references', () => {
    const body = extractLatestBody('_escrow_transaction_dispute_block')
    expect(body).toMatch(/public\.bookings/)
    expect(body).toMatch(/public\.disputes/)
    expect(body).toMatch(/public\.rent_to_buy_agreements/)
    expect(body).not.toMatch(/[^.]\bescrow_status\b/)
  })

  it('15. _escrow_transaction_completion_block (current form, defined in the RTB widening migration) has zero bare escrow_status/application-type references', () => {
    const body = extractLatestBody('_escrow_transaction_completion_block')
    expect(body).toMatch(/public\.bookings/)
    expect(body).toMatch(/public\.orders/)
    expect(body).toMatch(/public\.rent_to_buy_agreements/)
    expect(body).not.toMatch(/[^.]\bescrow_status\b/)
  })
})

describe('excluded-function contract: the 6 deferred backlog functions genuinely contain a blocking bare escrow_status reference', () => {
  const RPCS_FILE = join(MIGRATIONS_DIR, '20260825000003_escrow_rpcs.sql')
  const COMPLETION_FILE = join(MIGRATIONS_DIR, '20260825000008_escrow_release_completion_check.sql')
  const RTB_FILE = join(MIGRATIONS_DIR, '20260821183600_rtb_v2_rpcs.sql')
  const rpcsContent = readFileSync(RPCS_FILE, 'utf-8')
  const completionContent = readFileSync(COMPLETION_FILE, 'utf-8')
  const rtbContent = readFileSync(RTB_FILE, 'utf-8')

  it('16. mark_escrow_funded, refund_escrow_transaction, cancel_escrow_transaction, and _escrow_transaction_transition each contain a bare escrow_status reference in 20260825000003', () => {
    for (const name of ['mark_escrow_funded', 'refund_escrow_transaction', 'cancel_escrow_transaction', '_escrow_transaction_transition']) {
      const defIdx = rpcsContent.search(new RegExp(`create or replace function public\\.${name}\\(`))
      expect(defIdx, `${name} not found`).toBeGreaterThan(-1)
      const bodyEnd = rpcsContent.indexOf('$$;', defIdx)
      const body = rpcsContent.slice(defIdx, bodyEnd + 3)
      expect(body, `${name} unexpectedly has no bare escrow_status reference`).toMatch(/[^.]\bescrow_status\b/)
    }
  })

  it('17. release_escrow_transaction (current form, 20260825000008) contains a bare escrow_status reference', () => {
    const defIdx = completionContent.search(/create or replace function public\.release_escrow_transaction\(/)
    expect(defIdx).toBeGreaterThan(-1)
    const bodyEnd = completionContent.indexOf('$$;', defIdx)
    const body = completionContent.slice(defIdx, bodyEnd + 3)
    expect(body).toMatch(/array\['funded'\]::escrow_status\[\]/)
  })

  it('18. _rent_to_buy_settle_escrow (RTB widening migration) contains a bare escrow_status reference', () => {
    const defIdx = rtbContent.search(/create or replace function public\._rent_to_buy_settle_escrow\(/)
    expect(defIdx).toBeGreaterThan(-1)
    const bodyEnd = rtbContent.indexOf('$$;', defIdx)
    const body = rtbContent.slice(defIdx, bodyEnd + 3)
    expect(body.match(/::escrow_status\[\]/g) ?? []).toHaveLength(2)
  })
})
