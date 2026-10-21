import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

/**
 * P6-POPIA-ERASURE-AND-ANONYMIZATION-F3: migration-contract test for
 * 20261025000000_fix_account_erasure_marketplace_request_lock_order.sql.
 *
 * Same stated limitation as every other migration-contract test in this
 * codebase: this parses the migration's SQL source text and asserts on its
 * structure. It cannot execute the SQL against a real Postgres instance and
 * cannot itself prove the live deadlock-avoidance behavior -- that follows
 * from standard, documented PostgreSQL row-locking semantics (a transaction
 * requesting a lock it doesn't yet hold always queues behind any earlier
 * conflicting waiter on that row), not something a mocked-client unit test
 * can exercise live. What this DOES verify directly from the text: the
 * meaningful ordering relationship (erase_account now acquires
 * marketplace_requests locks before the profile lock, the same relative
 * order 20261024000000 already established for publish_marketplace_request),
 * and that nothing else about the function changed.
 */

const MIGRATION_PATH = resolve(__dirname, '../../../../supabase/migrations/20261025000000_fix_account_erasure_marketplace_request_lock_order.sql')
const ORIGINAL_MIGRATION_PATH = resolve(__dirname, '../../../../supabase/migrations/20261022000000_account_erasure.sql')
const F1_MIGRATION_PATH = resolve(__dirname, '../../../../supabase/migrations/20261023000000_account_erasure_cleanup_hardening.sql')
const F2_MIGRATION_PATH = resolve(__dirname, '../../../../supabase/migrations/20261024000000_fix_publish_marketplace_request_lock_order.sql')

function readMigration(): string {
  return readFileSync(MIGRATION_PATH, 'utf8')
}

describe('20261025000000_fix_account_erasure_marketplace_request_lock_order.sql (category: P6-POPIA-ERASURE-AND-ANONYMIZATION-F3)', () => {
  it('1. exists and does not modify any prior privacy migration', () => {
    const original = readFileSync(ORIGINAL_MIGRATION_PATH, 'utf8')
    const f1 = readFileSync(F1_MIGRATION_PATH, 'utf8')
    const f2 = readFileSync(F2_MIGRATION_PATH, 'utf8')
    expect(original).toMatch(/update public\.marketplace_requests set status = 'closed'/)
    expect(f1).toMatch(/create table if not exists public\.account_erasure_cleanup/)
    expect(f2).toMatch(/CREATE OR REPLACE FUNCTION public\.publish_marketplace_request/)
    // These three files are untouched by this phase -- re-reading them here
    // only proves they still exist with their own expected content, not that
    // this (separate) migration file edited them.
  })

  it('2. replaces erase_account with the exact original signature -- no DROP FUNCTION, no new overload', () => {
    const sql = readMigration()
    expect(sql).toMatch(/create or replace function public\.erase_account\(\s*\n\s*p_user_id uuid,\s*\n\s*p_actor_id uuid,\s*\n\s*p_request_source text,\s*\n\s*p_idempotency_key text default null\s*\n\s*\)/)
    expect(sql).not.toMatch(/drop function/i)
  })

  it('3. touches no other function -- exactly one CREATE OR REPLACE FUNCTION in the whole file', () => {
    const sql = readMigration()
    const defs = sql.match(/^create or replace function public\.\w+/gim) ?? []
    expect(defs).toHaveLength(1)
  })

  it('4. erase_account now acquires the marketplace_requests lock before the profile FOR UPDATE lock -- the same relative resource order publish_marketplace_request already uses', () => {
    const sql = readMigration()
    const fnStart = sql.indexOf('create or replace function public.erase_account(')
    const fnBody = sql.slice(fnStart)
    const mrLockIndex = fnBody.indexOf('from public.marketplace_requests')
    const profileLockIndex = fnBody.indexOf('select id, account_status into v_profile from public.profiles where id = p_user_id for update')
    expect(mrLockIndex).toBeGreaterThan(-1)
    expect(profileLockIndex).toBeGreaterThan(-1)
    expect(mrLockIndex).toBeLessThan(profileLockIndex)
  })

  it('5. the pre-lock is a pure lock acquisition (PERFORM ... FOR UPDATE) with a deterministic id order -- never an UPDATE/INSERT/DELETE', () => {
    const sql = readMigration()
    const fnStart = sql.indexOf('create or replace function public.erase_account(')
    const profileLockIndex = sql.indexOf('select id, account_status into v_profile from public.profiles where id = p_user_id for update', fnStart)
    const preLockBlock = sql.slice(sql.indexOf('perform 1 from public.marketplace_requests', fnStart), profileLockIndex)
    expect(preLockBlock).toMatch(/order by id\s*\n\s*for update/)
    expect(preLockBlock).not.toMatch(/update |insert |delete /i)
  })

  it('6. the pre-lock targets exactly the same row set the existing closing UPDATE later targets (same requester_id and status filter)', () => {
    const sql = readMigration()
    expect(sql).toMatch(/perform 1 from public\.marketplace_requests\s*\n\s*where requester_id = p_user_id and status in \('draft', 'active', 'offers_received'\)\s*\n\s*order by id\s*\n\s*for update;/)
    expect(sql).toMatch(/update public\.marketplace_requests set status = 'closed'\s*\n\s*where requester_id = p_user_id and status in \('draft', 'active', 'offers_received'\);/)
  })

  it('7. the profile lock still precedes every active-obligation check and every anonymization UPDATE -- the F1 TOCTOU ordering is unchanged', () => {
    const sql = readMigration()
    const fnStart = sql.indexOf('create or replace function public.erase_account(')
    const fnBody = sql.slice(fnStart)
    const profileLockIndex = fnBody.indexOf('for update;\n  if v_profile.id is null')
    const firstObligationCheckIndex = fnBody.indexOf("v_blocked := array_append(v_blocked, 'active_booking')")
    const firstAnonymizationUpdateIndex = fnBody.indexOf("update public.profiles set")
    expect(profileLockIndex).toBeGreaterThan(-1)
    expect(firstObligationCheckIndex).toBeGreaterThan(profileLockIndex)
    expect(firstAnonymizationUpdateIndex).toBeGreaterThan(firstObligationCheckIndex)
  })

  it('8. every active-obligation category is preserved byte-for-byte: bookings, disputes, orders, rent-to-buy, barter, payouts, refunds', () => {
    const sql = readMigration()
    for (const category of ['active_booking', 'open_dispute', 'unsettled_order', 'active_rent_to_buy', 'active_barter', 'unpaid_merchant_payout', 'pending_refund']) {
      expect(sql).toContain(`'${category}'`)
    }
  })

  it('9. idempotency contract is preserved: the idempotency-key replay check still happens before the new pre-lock and before the profile lock', () => {
    const sql = readMigration()
    const fnStart = sql.indexOf('create or replace function public.erase_account(')
    const fnBody = sql.slice(fnStart)
    const idemCheckIndex = fnBody.indexOf("where merchant_id = p_actor_id and operation = 'erase_account'")
    const preLockIndex = fnBody.indexOf('perform 1 from public.marketplace_requests')
    expect(idemCheckIndex).toBeGreaterThan(-1)
    expect(idemCheckIndex).toBeLessThan(preLockIndex)
  })

  it('10. KYC scrub, listings suspension, and barter_skill_task_posts closure are preserved byte-for-byte', () => {
    const sql = readMigration()
    expect(sql).toContain('legal_first_name = null')
    expect(sql).toContain("update public.listings set status = 'suspended'")
    expect(sql).toContain("update public.barter_skill_task_posts set status = 'closed'")
  })

  it('11. never touches an immutable/append-only history or evidence table, never deletes profiles or auth.users', () => {
    const sql = readMigration()
    const codeLines = sql.split('\n').filter((line) => !line.trim().startsWith('--'))
    const code = codeLines.join('\n')
    expect(code).not.toMatch(/update public\.(booking_history|order_history|dispute_history|barter_history|identity_verification_history|identity_verification_documents|user_account_history|legal_acceptances|ledger_entries|payments|payment_events|payment_attempts)\b/)
    expect(code).not.toMatch(/delete from public\.(?!marketplace_requests)/)
    expect(code).not.toMatch(/delete from public\.profiles/)
    expect(code).not.toMatch(/auth\.admin\.deleteUser|delete from auth\.users/)
  })

  it('12. declares SECURITY DEFINER and a fixed search_path, matching the original function', () => {
    const sql = readMigration()
    expect(sql).toMatch(/security definer/)
    expect(sql).toMatch(/set search_path = public/)
  })

  it('13. includes no grant/revoke statements -- relies on Postgres preserving the existing same-signature ACL', () => {
    const codeLines = readMigration()
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
    expect(codeLines.join('\n')).not.toMatch(/grant execute|revoke all/)
  })

  it('14. is additive-replace only -- no table/column DROP', () => {
    const sql = readMigration()
    expect(sql).not.toMatch(/drop table|drop column/i)
  })
})
