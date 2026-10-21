import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

/**
 * P6-POPIA-ERASURE-AND-ANONYMIZATION-F2: migration-contract test for
 * 20261024000000_fix_publish_marketplace_request_lock_order.sql.
 *
 * Same stated limitation as every other migration-contract test in this
 * codebase: this parses the migration's SQL source text and asserts on its
 * structure. It cannot execute the SQL against a real Postgres instance and
 * cannot itself prove the live lock-conflict/deadlock-avoidance behavior --
 * that is standard PostgreSQL MVCC locking semantics (FOR SHARE/FOR UPDATE
 * compatibility, and that requesting a weaker lock on a row you already
 * hold a stronger lock on is a safe no-op), not something a mocked-client
 * unit test can exercise live. What this DOES verify directly from the
 * text: the meaningful ordering relationship (the FOR UPDATE-taking call
 * now precedes the FOR SHARE-taking call within the same function body),
 * and that nothing else was touched.
 */

const MIGRATION_PATH = resolve(__dirname, '../../../../supabase/migrations/20261024000000_fix_publish_marketplace_request_lock_order.sql')
const ORIGINAL_MIGRATION_PATH = resolve(__dirname, '../../../../supabase/migrations/20261022000000_account_erasure.sql')
const F1_MIGRATION_PATH = resolve(__dirname, '../../../../supabase/migrations/20261023000000_account_erasure_cleanup_hardening.sql')
const PUBLICATION_HARDENING_PATH = resolve(__dirname, '../../../../supabase/migrations/20260904000006_marketplace_request_account_status_hardening.sql')

function readMigration(): string {
  return readFileSync(MIGRATION_PATH, 'utf8')
}

describe('20261024000000_fix_publish_marketplace_request_lock_order.sql (category: P6-POPIA-ERASURE-AND-ANONYMIZATION-F2)', () => {
  it('1. exists and does not modify either prior privacy migration', () => {
    const original = readFileSync(ORIGINAL_MIGRATION_PATH, 'utf8')
    const f1 = readFileSync(F1_MIGRATION_PATH, 'utf8')
    expect(original).toMatch(/create or replace function public\.erase_account/)
    expect(f1).toMatch(/create table if not exists public\.account_erasure_cleanup/)
    // These two files are untouched by this phase -- re-reading them here
    // only proves they still exist and still contain their own expected
    // content, not that this migration edited them (it is a separate file).
  })

  it('2. replaces publish_marketplace_request with the exact original signature -- no DROP FUNCTION, no new overload', () => {
    const sql = readMigration()
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.publish_marketplace_request\(p_actor_user_id uuid, p_request_id uuid, p_idempotency_key text DEFAULT NULL::text\)/)
    expect(sql).not.toMatch(/drop function/i)
  })

  it('3. touches no other function -- exactly one CREATE OR REPLACE FUNCTION in the whole file', () => {
    const sql = readMigration()
    const defs = sql.match(/^CREATE OR REPLACE FUNCTION public\.\w+/gim) ?? []
    expect(defs).toHaveLength(1)
  })

  it('4. the lock-and-count call (FOR UPDATE) now precedes the account-status guard call (FOR SHARE) within the function body', () => {
    const sql = readMigration()
    const fnStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.publish_marketplace_request')
    const fnBody = sql.slice(fnStart)
    const lockAndCountIndex = fnBody.indexOf('_lock_and_count_active_supply(p_actor_user_id)')
    const guardIndex = fnBody.indexOf('_assert_account_status_permits_creation(p_actor_user_id')
    expect(lockAndCountIndex).toBeGreaterThan(-1)
    expect(guardIndex).toBeGreaterThan(-1)
    expect(lockAndCountIndex).toBeLessThan(guardIndex)
  })

  it('5. the account-status guard still runs before the request is actually published (status set to active)', () => {
    const sql = readMigration()
    const fnStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.publish_marketplace_request')
    const fnBody = sql.slice(fnStart)
    const guardIndex = fnBody.indexOf('_assert_account_status_permits_creation(p_actor_user_id')
    const publishIndex = fnBody.indexOf("update public.marketplace_requests set status = 'active'")
    expect(guardIndex).toBeGreaterThan(-1)
    expect(publishIndex).toBeGreaterThan(-1)
    expect(guardIndex).toBeLessThan(publishIndex)
  })

  it('6. the test-request short-circuit (is_test) is unchanged -- the supply lock/count is still only taken for non-test requests', () => {
    const sql = readMigration()
    expect(sql).toMatch(/if not v_request\.is_test then\s*\n\s*v_active_count := public\._lock_and_count_active_supply\(p_actor_user_id\);/)
  })

  it('7. every other check is preserved byte-for-byte relative to the live definition this replaces: auth/actor/ownership/draft-status/KYC/frozen/limit/history/result', () => {
    const sql = readMigration()
    const live = readFileSync(PUBLICATION_HARDENING_PATH, 'utf8')
    const checks = [
      "if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;",
      "if p_actor_user_id is null then raise exception 'not authenticated'; end if;",
      'select * into v_request from public.marketplace_requests where id = p_request_id for update;',
      "if v_request.id is null then raise exception 'request not found'; end if;",
      "if v_request.requester_id <> p_actor_user_id then raise exception 'not the owner of this request'; end if;",
      "if v_request.status <> 'draft' then raise exception 'request is in status % and cannot be published from here', v_request.status; end if;",
      'select kyc_status::text into v_kyc from public.profiles where id = p_actor_user_id;',
      "if v_kyc is distinct from 'approved' then",
      'perform public._assert_not_publication_frozen(p_actor_user_id);',
      'v_plan_id := public._get_effective_merchant_plan_id(p_actor_user_id);',
      "if v_publication_limit is not null and v_active_count >= v_publication_limit then",
      "update public.marketplace_requests set status = 'active' where id = p_request_id;",
      "perform public._marketplace_request_history(p_request_id, null, 'requester', p_actor_user_id, 'published', 'draft', 'active');",
      "v_result := jsonb_build_object('request_id', p_request_id, 'status', 'active');",
    ]
    for (const line of checks) {
      expect(sql, `missing/changed line: ${line}`).toContain(line)
      expect(live, `original migration no longer contains: ${line}`).toContain(line)
    }
  })

  it('8. is additive-replace only -- no table/column DROP, no DELETE', () => {
    const sql = readMigration()
    expect(sql).not.toMatch(/drop table|drop column|delete from/i)
  })

  it('9. declares SECURITY DEFINER and a fixed search_path, matching the original function', () => {
    const sql = readMigration()
    expect(sql).toMatch(/SECURITY DEFINER/)
    expect(sql).toMatch(/SET search_path TO 'public'/)
  })

  it('10. includes no grant/revoke statements -- relies on Postgres preserving the existing same-signature ACL, matching this migration\'s own documented reasoning', () => {
    const sql = readMigration()
    expect(sql).not.toMatch(/grant execute|revoke all/)
  })
})
