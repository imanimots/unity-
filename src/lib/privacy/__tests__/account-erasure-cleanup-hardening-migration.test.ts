import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

/**
 * P6-POPIA-ERASURE-AND-ANONYMIZATION-F1: migration-contract test for
 * 20261023000000_account_erasure_cleanup_hardening.sql.
 *
 * Same stated limitation as account-erasure-migration.test.ts: this parses
 * the migration's SQL source text and asserts on its structure. It does NOT
 * execute the SQL against a real Postgres instance, and cannot itself prove
 * Postgres's actual FOR SHARE/FOR UPDATE conflict behavior live -- that is
 * standard, well-documented MVCC locking semantics, not something unique to
 * this migration, so the live locking GUARANTEE is traced in prose in the
 * migration's own header comment rather than re-derived here.
 */

const MIGRATION_PATH = resolve(__dirname, '../../../../supabase/migrations/20261023000000_account_erasure_cleanup_hardening.sql')
const ORIGINAL_MIGRATION_PATH = resolve(__dirname, '../../../../supabase/migrations/20261022000000_account_erasure.sql')

function readMigration(): string {
  return readFileSync(MIGRATION_PATH, 'utf8')
}

describe('20261023000000_account_erasure_cleanup_hardening.sql (category: P6-POPIA-ERASURE-AND-ANONYMIZATION-F1)', () => {
  it('1. does not modify the already-committed 20261022000000_account_erasure.sql file', () => {
    // Read-only existence/content sanity check -- this test file lives
    // alongside the original migration's own test and must never assert
    // this migration file was rewritten.
    const original = readFileSync(ORIGINAL_MIGRATION_PATH, 'utf8')
    expect(original).toMatch(/create or replace function public\.erase_account/)
    expect(original).not.toMatch(/for share/)
  })

  it('2. creates account_erasure_cleanup with the required columns, FK to profiles (never auth.users), and no immutability trigger', () => {
    const sql = readMigration()
    const tableBlock = sql.slice(sql.indexOf('create table if not exists public.account_erasure_cleanup'), sql.indexOf('alter table public.account_erasure_cleanup enable row level security'))
    expect(tableBlock).toMatch(/user_id\s+uuid primary key references public\.profiles\(id\)/)
    expect(tableBlock).toMatch(/auth_ban_complete\s+boolean not null default false/)
    expect(tableBlock).toMatch(/avatar_cleanup_complete\s+boolean not null default false/)
    expect(tableBlock).toMatch(/kyc_cleanup_complete\s+boolean not null default false/)
    expect(tableBlock).toMatch(/attempt_count\s+int not null default 0/)
    expect(tableBlock).not.toMatch(/references auth\.users/)
    // Deliberately mutable (upserted on every cleanup attempt) -- unlike
    // account_erasure_log, this table must NOT be wired to
    // prevent_row_mutation().
    expect(sql).not.toMatch(/account_erasure_cleanup_immutable/)
    expect(sql).not.toMatch(/before update or delete on public\.account_erasure_cleanup/)
  })

  it('3. enables RLS on account_erasure_cleanup with an admin-only read policy and zero client write policies', () => {
    const sql = readMigration()
    expect(sql).toMatch(/alter table public\.account_erasure_cleanup enable row level security/)
    const policyBlocks = sql.match(/create policy "account_erasure_cleanup:[^"]*"/g) ?? []
    expect(policyBlocks).toHaveLength(1)
    const policyStatement = sql.slice(sql.indexOf('create policy "account_erasure_cleanup: admin read"'), sql.indexOf(';', sql.indexOf('create policy "account_erasure_cleanup: admin read"')))
    expect(policyStatement).toMatch(/profiles\.role = 'admin'/)
    expect(policyStatement).not.toMatch(/for (insert|update|delete)/)
  })

  it('4. both account-status guard functions now lock the profile row with FOR SHARE before reading its status', () => {
    const sql = readMigration()
    const creationFn = sql.slice(sql.indexOf('create or replace function public._assert_account_status_permits_creation'), sql.indexOf('create or replace function public._assert_account_status_permits_transaction'))
    const transactionFn = sql.slice(sql.indexOf('create or replace function public._assert_account_status_permits_transaction'))
    expect(creationFn).toMatch(/select account_status::text into v_status from public\.profiles where id = p_user_id for share/)
    expect(transactionFn).toMatch(/select account_status::text into v_status from public\.profiles where id = p_user_id for share/)
  })

  it('5. neither guard function uses FOR UPDATE -- only FOR SHARE, which is what makes concurrent two-party transaction-creation calls deadlock-free against each other', () => {
    const sql = readMigration()
    const codeLines = sql.split('\n').filter((line) => !line.trim().startsWith('--'))
    expect(codeLines.join('\n')).not.toMatch(/for update/)
  })

  it('6. preserves the exact same blocking status checks as the original migration -- creation blocks restricted/suspended/erased, transaction blocks suspended/erased', () => {
    const sql = readMigration()
    expect(sql).toMatch(/v_status in \('restricted', 'suspended', 'erased'\)/)
    expect(sql).toMatch(/v_status in \('suspended', 'erased'\)/)
  })

  it('7. is additive only -- no DROP/DELETE of any existing table, function, or row', () => {
    const sql = readMigration()
    expect(sql).not.toMatch(/drop table|drop column|delete from/i)
  })
})
