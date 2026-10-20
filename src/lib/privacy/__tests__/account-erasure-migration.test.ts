import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

/**
 * P6-POPIA-ERASURE-AND-ANONYMIZATION-I: migration-contract test for
 * 20261022000000_account_erasure.sql.
 *
 * Same stated limitation as booking-condition-evidence-migration.test.ts:
 * this parses the migration's SQL source text and asserts on its
 * structure. It does NOT execute the SQL against a real Postgres instance.
 */

const MIGRATION_PATH = resolve(__dirname, '../../../../supabase/migrations/20261022000000_account_erasure.sql')

function readMigration(): string {
  return readFileSync(MIGRATION_PATH, 'utf8')
}

describe('20261022000000_account_erasure.sql (category: P6-POPIA-ERASURE-AND-ANONYMIZATION-I)', () => {
  it('1. adds the erased value to the existing profile_account_status enum -- never creates a new enum', () => {
    const sql = readMigration()
    expect(sql).toMatch(/alter type profile_account_status add value if not exists 'erased'/)
    expect(sql).not.toMatch(/create type profile_account_status/)
  })

  it('2. extends both existing cross-cutting account-status guards to also block erased', () => {
    const sql = readMigration()
    expect(sql).toMatch(/create or replace function public\._assert_account_status_permits_creation[\s\S]*?v_status in \('restricted', 'suspended', 'erased'\)/)
    expect(sql).toMatch(/create or replace function public\._assert_account_status_permits_transaction[\s\S]*?v_status in \('suspended', 'erased'\)/)
  })

  it('3. creates account_erasure_log with the required columns and FKs to profiles, never to auth.users directly', () => {
    const sql = readMigration()
    const tableBlock = sql.slice(sql.indexOf('create table if not exists public.account_erasure_log'), sql.indexOf('create index if not exists account_erasure_log_user_idx'))
    expect(tableBlock).toMatch(/create table if not exists public\.account_erasure_log/)
    expect(tableBlock).toMatch(/user_id\s+uuid not null references public\.profiles\(id\)/)
    expect(tableBlock).toMatch(/requested_by\s+uuid not null references public\.profiles\(id\)/)
    expect(tableBlock).toMatch(/request_source\s+text not null check \(request_source in \('self_service', 'admin'\)\)/)
    expect(tableBlock).toMatch(/outcome\s+text not null check \(outcome in \('completed', 'blocked'\)\)/)
    expect(tableBlock).not.toMatch(/references auth\.users/)
  })

  it('4. enables RLS on account_erasure_log with an admin-only read policy and zero client write policies', () => {
    const sql = readMigration()
    expect(sql).toMatch(/alter table public\.account_erasure_log enable row level security/)
    const policyBlocks = sql.match(/create policy "account_erasure_log:[^"]*"/g) ?? []
    expect(policyBlocks).toHaveLength(1)
    // Bounded to this one policy's own statement (up to its terminating
    // semicolon) -- an unbounded [\s\S]*? would also match the unrelated
    // "for update" row-lock clause much further down in erase_account().
    const policyStatement = sql.slice(sql.indexOf('create policy "account_erasure_log: admin read"'), sql.indexOf(';', sql.indexOf('create policy "account_erasure_log: admin read"')))
    expect(policyStatement).toMatch(/profiles\.role = 'admin'/)
    expect(policyStatement).not.toMatch(/for (insert|update|delete)/)
  })

  it('5. account_erasure_log is immutable via the existing prevent_row_mutation() trigger -- no new mutation-prevention function defined', () => {
    const sql = readMigration()
    expect(sql).toMatch(/create trigger account_erasure_log_immutable_trg\s*\n\s*before update or delete on public\.account_erasure_log\s*\n\s*for each row execute procedure public\.prevent_row_mutation\(\)/)
    expect(sql).not.toMatch(/create (or replace )?function public\.prevent_row_mutation/)
  })

  it('6. erase_account is service-role gated and rejects an admin erasing their own account', () => {
    const sql = readMigration()
    expect(sql).toMatch(/create or replace function public\.erase_account/)
    expect(sql).toMatch(/if auth\.role\(\) <> 'service_role' then\s*\n\s*raise exception 'not authorized'/)
    expect(sql).toMatch(/if p_request_source = 'admin' and p_actor_id = p_user_id then\s*\n\s*raise exception 'use the self-service erasure flow for your own account'/)
  })

  it('7. the active-obligation gate checks bookings, disputes, orders, rent-to-buy, barter, payouts, and refunds before ever anonymizing', () => {
    const sql = readMigration()
    // Scoped to erase_account's own function body -- set_user_account_status
    // (also replaced by this migration, for its own unrelated "erased is
    // terminal" guard) contains an earlier, unrelated "update public.profiles
    // set" of its own.
    const fnStart = sql.indexOf('create or replace function public.erase_account(')
    const fnBody = sql.slice(fnStart)
    const gateIndex = fnBody.indexOf('if not v_already_erased then')
    const updateIndex = fnBody.indexOf("update public.profiles set")
    expect(fnStart).toBeGreaterThan(-1)
    expect(gateIndex).toBeGreaterThan(-1)
    expect(updateIndex).toBeGreaterThan(gateIndex)
    for (const category of ['active_booking', 'open_dispute', 'unsettled_order', 'active_rent_to_buy', 'active_barter', 'unpaid_merchant_payout', 'pending_refund']) {
      const categoryIndex = fnBody.indexOf(`'${category}'`)
      expect(categoryIndex).toBeGreaterThan(gateIndex)
      expect(categoryIndex).toBeLessThan(updateIndex)
    }
  })

  it('15. set_user_account_status is extended so an erased account can never be restored back to active', () => {
    const sql = readMigration()
    const fnStart = sql.indexOf('create or replace function public.set_user_account_status(')
    const fnBody = sql.slice(fnStart, sql.indexOf('-- ─────────────────────────────────────────\n-- account_erasure_log'))
    expect(fnStart).toBeGreaterThan(-1)
    expect(fnBody).toMatch(/if v_previous_status::text = 'erased' then\s*\n\s*raise exception 'an erased account can never be restored'/)
  })

  it('8. a blocked attempt is logged and returned without ever reaching the anonymization UPDATEs', () => {
    const sql = readMigration()
    expect(sql).toMatch(/if array_length\(v_blocked, 1\) > 0 then[\s\S]*?insert into public\.account_erasure_log \(user_id, requested_by, request_source, outcome, blocked_categories, completed_at\)\s*\n\s*values \(p_user_id, p_actor_id, p_request_source, 'blocked', v_blocked, null\);[\s\S]*?return v_result;\s*\n\s*end if;/)
  })

  it('9. never deletes or updates any immutable/append-only history or evidence table', () => {
    const sql = readMigration()
    expect(sql).not.toMatch(/update public\.(booking_history|order_history|dispute_history|barter_history|identity_verification_history|identity_verification_documents|user_account_history|legal_acceptances|ledger_entries|payments|payment_events|payment_attempts)\b/)
    expect(sql).not.toMatch(/delete from public\./)
    expect(sql).not.toMatch(/drop table|drop column/i)
  })

  it('10. never deletes profiles or auth.users -- only ever UPDATEs the mutable profiles row in place', () => {
    const sql = readMigration()
    // Scoped to actual SQL statements, not the header comment's own prose
    // explaining WHY a hard delete is unsafe (which legitimately mentions
    // both terms descriptively).
    const codeLines = sql.split('\n').filter((line) => !line.trim().startsWith('--'))
    const code = codeLines.join('\n')
    expect(code).not.toMatch(/delete from public\.profiles/)
    expect(code).not.toMatch(/auth\.admin\.deleteUser|delete from auth\.users/)
    expect(code).toMatch(/update public\.profiles set\s*\n\s*full_name = 'Deleted User'/)
  })

  it('11. anonymizes identity_verifications PII fields by user_id (its primary key) without touching its status/review columns', () => {
    const sql = readMigration()
    expect(sql).toMatch(/update public\.identity_verifications set\s*\n\s*legal_first_name = null/)
    expect(sql).toMatch(/where user_id = p_user_id/)
    const block = sql.slice(sql.indexOf('update public.identity_verifications'), sql.indexOf('where user_id = p_user_id') + 30)
    expect(block).not.toMatch(/\bstatus\s*=/)
  })

  it('12. scrubs the denormalized recipient_email copy on email_deliveries without deleting the delivery row itself', () => {
    const sql = readMigration()
    expect(sql).toMatch(/update public\.email_deliveries set recipient_email = null where recipient_user_id = p_user_id/)
  })

  it('13. the erase_account RPC is revoked from public/anon/authenticated and granted only to service_role', () => {
    const sql = readMigration()
    expect(sql).toMatch(/revoke all on function public\.erase_account\(uuid, uuid, text, text\) from public, anon, authenticated/)
    expect(sql).toMatch(/grant execute on function public\.erase_account\(uuid, uuid, text, text\) to service_role/)
  })

  it('14. is idempotency-keyed using the existing idempotency_keys table convention, not a bespoke mechanism', () => {
    const sql = readMigration()
    expect(sql).toMatch(/from public\.idempotency_keys\s*\n\s*where merchant_id = p_actor_id and operation = 'erase_account' and idempotency_key = p_idempotency_key/)
  })
})
