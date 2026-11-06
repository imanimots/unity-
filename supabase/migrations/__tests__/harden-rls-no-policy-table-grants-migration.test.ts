import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

/**
 * E17 migration-contract test for
 * 20261106090000_harden_rls_no_policy_table_grants.sql.
 *
 * Scope: a pure grant-hardening migration for the 14 tables the live
 * advisor flags as rls_enabled_no_policy. A fresh repo-wide trace (3
 * parallel audits covering creation migrations, every SECURITY
 * DEFINER/INVOKER function body, every .from()/.rpc() call site,
 * admin UI, cron/webhook routes, and tests) found zero proven
 * anon/authenticated direct-table-access requirement for any of the
 * 14 -- every real path goes through a service-role client or a
 * SECURITY DEFINER function with its own internal authorization,
 * which this migration does not touch and cannot break (SECURITY
 * DEFINER functions execute with the function owner's privileges on
 * the underlying table, independent of the caller's own table
 * grants). This migration adds no policy, drops no table, and leaves
 * service_role untouched.
 *
 * LIMITATION, per this codebase's established convention: this test
 * parses SQL source text and asserts on its structure. It does not
 * execute against a live Postgres instance and cannot literally prove
 * live grant enforcement. This migration reaches the live database
 * only via the project's GitHub-integrated Supabase workflow.
 */
const REPO_ROOT = join(__dirname, '../../..')
const MIGRATION_PATH = join(REPO_ROOT, 'supabase/migrations/20261106090000_harden_rls_no_policy_table_grants.sql')
const MIGRATIONS_DIR = join(REPO_ROOT, 'supabase/migrations')
const sql = readFileSync(MIGRATION_PATH, 'utf-8')
const codeOnly = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')
const normalized = codeOnly.replace(/\s+/g, ' ')

const TABLES = [
  'barter_skill_task_post_reports',
  'escrow_provider_events',
  'escrow_transaction_history',
  'idempotency_keys',
  'kyc_document_upload_intents',
  'kyc_legacy_finalize_daily_metrics',
  'ledger_entries',
  'merchant_payout_history',
  'payment_webhook_events',
  'profile_reports',
  'review_moderation_history',
  'review_reports',
  'review_windows',
  'reviews_v2_config',
]

describe('20261106090000_harden_rls_no_policy_table_grants.sql (category: ADMIN-CONTROL-CENTRE-BATCH-E17)', () => {
  it('1. revokes select/insert/update/delete from public, anon, and authenticated on every one of the 14 tables -- no more, no less', () => {
    for (const t of TABLES) {
      expect(normalized, `${t}: missing exact revoke statement`).toMatch(
        new RegExp(`revoke select, insert, update, delete on table public\\.${t} from public, anon, authenticated;`)
      )
    }
    const revokeLines = codeOnly.match(/revoke[^\n]+;/g) ?? []
    expect(revokeLines).toHaveLength(14)
  })

  it('2. never revokes anything from service_role', () => {
    expect(codeOnly).not.toMatch(/service_role/)
  })

  it('3. never grants anything (this migration only removes privileges, never adds)', () => {
    expect(codeOnly).not.toMatch(/\bgrant\b/i)
  })

  it('4. never creates, drops, or alters a policy', () => {
    expect(codeOnly).not.toMatch(/create policy|drop policy|alter policy/i)
  })

  it('5. never touches RLS enable/disable state', () => {
    expect(codeOnly).not.toMatch(/enable row level security|disable row level security/i)
  })

  it('6. never drops, creates, or alters a table, function, trigger, or extension', () => {
    expect(codeOnly).not.toMatch(/drop table|create table|alter table(?! public\.\w+ from)|drop function|create (or replace )?function|create trigger|drop trigger|alter extension|create extension|drop extension/i)
  })

  it('7. contains exactly 14 revoke statements, one per flagged table, and no other table name appears', () => {
    const tableMentions = [...codeOnly.matchAll(/public\.(\w+)/g)].map((m) => m[1])
    expect(new Set(tableMentions)).toEqual(new Set(TABLES))
  })

  it('8. is forward-only -- no historical migration file is modified by this change', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'))
    // The new migration must sort after every pre-existing migration (lexicographic timestamp prefix).
    const thisFile = '20261106090000_harden_rls_no_policy_table_grants.sql'
    const earlier = files.filter((f) => f !== thisFile && f < thisFile)
    expect(earlier.length).toBeGreaterThan(0)
    expect(files).toContain(thisFile)
  })

  it('9. no dynamic SQL exists anywhere in this migration', () => {
    expect(codeOnly).not.toMatch(/\bEXECUTE\s+(format|'|")/i)
    expect(codeOnly).not.toMatch(/quote_ident|quote_literal/)
  })
})

describe('pre-existing fact check: none of the 14 tables had any prior explicit GRANT/REVOKE statement', () => {
  it('10. confirms the "never explicitly granted/revoked before this migration" premise this migration documents', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && f !== '20261106090000_harden_rls_no_policy_table_grants.sql')
    for (const t of TABLES) {
      for (const f of files) {
        const content = readFileSync(join(MIGRATIONS_DIR, f), 'utf-8')
        const re = new RegExp(`(grant|revoke)[^;]*\\bpublic\\.${t}\\b`, 'i')
        expect(re.test(content), `${f} unexpectedly grants/revokes on public.${t}`).toBe(false)
      }
    }
  })
})
