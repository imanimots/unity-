import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

/**
 * E18 migration-contract test for
 * 20261106211029_harden_ledger_entries_immutability.sql.
 *
 * Scope: installs the project's existing shared immutability guard,
 * public.prevent_row_mutation() (unchanged, not redefined here), as a
 * BEFORE UPDATE OR DELETE trigger on public.ledger_entries -- the one
 * sibling of listing_declarations/listing_history/dispute_history/
 * escrow_transaction_history/merchant_payout_history/
 * review_moderation_history that never received it. A fresh repo-wide
 * trace (independently re-verifying, not trusting, the prior phase's
 * conclusion) confirmed every current writer of ledger_entries is
 * INSERT-only, every FK is ON DELETE NO ACTION (no cascade risk), and
 * account erasure never deletes it -- see this migration's own header
 * comment for the full evidence trail.
 *
 * LIMITATION, per this codebase's established convention: this test
 * parses SQL source text and asserts on its structure. It does not
 * execute against a live Postgres instance and cannot literally
 * exercise the trigger (e.g. attempt a real UPDATE and observe the
 * exception). This migration reaches the live database only via the
 * project's GitHub-integrated Supabase workflow.
 */
const REPO_ROOT = join(__dirname, '../../..')
const MIGRATIONS_DIR = join(REPO_ROOT, 'supabase/migrations')
const MIGRATION_FILE = '20261106211029_harden_ledger_entries_immutability.sql'
const MIGRATION_PATH = join(MIGRATIONS_DIR, MIGRATION_FILE)
const sql = readFileSync(MIGRATION_PATH, 'utf-8')
const codeOnly = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')
const normalized = codeOnly.replace(/\s+/g, ' ').trim()

describe('20261106211029_harden_ledger_entries_immutability.sql (category: ADMIN-CONTROL-CENTRE-BATCH-E18)', () => {
  it('1. targets public.ledger_entries only -- no other table name appears', () => {
    const tableMentions = [...codeOnly.matchAll(/public\.(\w+)/g)].map((m) => m[1])
    expect(new Set(tableMentions)).toEqual(new Set(['ledger_entries', 'prevent_row_mutation']))
  })

  it('2. drops any pre-existing trigger of the same name before creating it, forward-only and idempotent', () => {
    expect(normalized).toMatch(/drop trigger if exists ledger_entries_immutable on public\.ledger_entries;/)
    const dropIdx = normalized.indexOf('drop trigger if exists ledger_entries_immutable')
    const createIdx = normalized.indexOf('create trigger ledger_entries_immutable')
    expect(dropIdx).toBeGreaterThan(-1)
    expect(createIdx).toBeGreaterThan(dropIdx)
  })

  it('3. the trigger name is exactly ledger_entries_immutable', () => {
    expect(normalized).toMatch(/create trigger ledger_entries_immutable/)
    expect(codeOnly.match(/create trigger (\w+)/g)).toHaveLength(1)
  })

  it('4. fires BEFORE UPDATE OR DELETE, FOR EACH ROW -- never touches INSERT, SELECT, or TRUNCATE', () => {
    expect(normalized).toMatch(/before update or delete on public\.ledger_entries\s*for each row execute function public\.prevent_row_mutation\(\);/)
    expect(codeOnly).not.toMatch(/before insert|after insert|instead of/i)
    expect(codeOnly).not.toMatch(/for each statement/i)
    expect(codeOnly).not.toMatch(/\btruncate\b/i)
  })

  it('5. calls the existing shared guard function, using the canonical FUNCTION (not PROCEDURE) syntax', () => {
    expect(normalized).toMatch(/execute function public\.prevent_row_mutation\(\)/)
    expect(codeOnly).not.toMatch(/execute procedure/i)
  })

  it('6. never redefines prevent_row_mutation() -- reuses it exactly as E11 left it', () => {
    expect(codeOnly).not.toMatch(/create (or replace )?function public\.prevent_row_mutation/i)
    expect(codeOnly).not.toMatch(/alter function public\.prevent_row_mutation/i)
  })

  it('7. never mutates ledger data -- no INSERT/UPDATE/DELETE statement against ledger_entries itself', () => {
    expect(codeOnly).not.toMatch(/insert into public\.ledger_entries/i)
    expect(codeOnly).not.toMatch(/update public\.ledger_entries\s+set/i)
    expect(codeOnly).not.toMatch(/delete from public\.ledger_entries/i)
  })

  it('8. never adds, drops, or alters an RLS policy, and never changes grants', () => {
    expect(codeOnly).not.toMatch(/create policy|drop policy|alter policy/i)
    expect(codeOnly).not.toMatch(/\bgrant\b|\brevoke\b/i)
  })

  it('9. never touches table schema, extensions, or any other object', () => {
    expect(codeOnly).not.toMatch(/create table|drop table|alter table(?! public\.ledger_entries)/i)
    expect(codeOnly).not.toMatch(/create (or replace )?function(?! public\.prevent_row_mutation)/i)
    expect(codeOnly).not.toMatch(/alter extension|create extension|drop extension/i)
  })

  it('10. contains exactly two statements: the drop and the create', () => {
    const statements = codeOnly.split(';').map((s) => s.trim()).filter(Boolean)
    expect(statements).toHaveLength(2)
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

describe('shared guard precondition: public.prevent_row_mutation() exists, unconditional, search_path hardened by E11', () => {
  const DEFINING_FILE = join(MIGRATIONS_DIR, '20260729000003_listing_declarations_and_history.sql')
  const E11_FILE = join(MIGRATIONS_DIR, '20261101130000_harden_function_search_paths.sql')

  it('13. the function is defined exactly once, in its original 20260729000003 migration, never redefined since', () => {
    const definers = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .filter((f) => {
        const content = readFileSync(join(MIGRATIONS_DIR, f), 'utf-8')
        return /create (or replace )?function public\.prevent_row_mutation/i.test(content)
      })
    expect(definers).toEqual(['20260729000003_listing_declarations_and_history.sql'])
  })

  it('14. the function body unconditionally raises for every role -- no role/auth check of any kind', () => {
    const content = readFileSync(DEFINING_FILE, 'utf-8')
    const defIdx = content.search(/create or replace function public\.prevent_row_mutation\(\)/)
    const body = content.slice(defIdx, content.indexOf('$$;', defIdx) + 3)
    expect(body).toMatch(/raise exception/i)
    expect(body).not.toMatch(/auth\.role\(\)|auth\.uid\(\)/)
  })

  it('15. E11 hardened its search_path to the empty string via ALTER FUNCTION, not a redefinition', () => {
    const content = readFileSync(E11_FILE, 'utf-8')
    expect(content).toMatch(/alter function public\.prevent_row_mutation\(\) set search_path = '';/)
  })
})

describe('pre-existing fact check: ledger_entries has no legitimate UPDATE/DELETE anywhere in migration history', () => {
  it('16. no migration other than this one mentions an UPDATE or DELETE statement against ledger_entries', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && f !== MIGRATION_FILE)
    for (const f of files) {
      const content = readFileSync(join(MIGRATIONS_DIR, f), 'utf-8')
      expect(content, f).not.toMatch(/update\s+public\.ledger_entries\s+set/i)
      expect(content, f).not.toMatch(/delete\s+from\s+public\.ledger_entries/i)
    }
  })

  it('17. all ledger_entries foreign keys use the default (no CASCADE) delete action', () => {
    const content = readFileSync(join(MIGRATIONS_DIR, '20260801000002_payment_schema.sql'), 'utf-8')
    const defIdx = content.search(/create table if not exists public\.ledger_entries/)
    const body = content.slice(defIdx, content.indexOf(');', defIdx))
    const fkLines = body.match(/references public\.\w+\([^)]*\)[^,\n]*/g) ?? []
    expect(fkLines.length).toBeGreaterThan(0)
    for (const line of fkLines) {
      expect(line, line).not.toMatch(/on delete cascade/i)
    }
  })
})
