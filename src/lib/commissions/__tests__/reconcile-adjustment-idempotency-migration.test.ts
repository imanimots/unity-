import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

/**
 * P5D-COMMISSION-REFUND-ADJUSTMENT-IDEMPOTENCY-I: migration-contract
 * test for 20261019000000_harden_unity_commission_adjustment_idempotency.sql.
 *
 * IMPORTANT LIMITATION, stated explicitly per this codebase's own
 * established convention (see expire-marketplace-requests-migration.test.ts
 * and siblings): this test parses the migration's SQL source text and
 * asserts on its structure. It does NOT execute the SQL against a real
 * Postgres instance and does NOT prove actual concurrent-transaction
 * conflict behavior -- no live database is available to this test
 * environment. The genuine safety property (two concurrent Postgres
 * transactions inserting the same unique-indexed value cannot both
 * succeed) is a well-established, documented Postgres guarantee that
 * this test corroborates structurally, not one it independently proves
 * by execution. A companion test (reconcile.test.ts) exercises the real
 * application-level RPC-call sequencing against a fake admin client that
 * simulates this exact ON CONFLICT behavior.
 */

const MIGRATION_PATH = resolve(__dirname, '../../../../supabase/migrations/20261019000000_harden_unity_commission_adjustment_idempotency.sql')

function readMigration(): string {
  return readFileSync(MIGRATION_PATH, 'utf8')
}

function functionBody(sql: string): string {
  const start = sql.indexOf('as $$')
  const end = sql.indexOf('$$;', start)
  expect(start, 'could not locate function body start').toBeGreaterThanOrEqual(0)
  expect(end, 'could not locate function body end').toBeGreaterThan(start)
  return sql.slice(start, end)
}

describe('20261019000000_harden_unity_commission_adjustment_idempotency.sql (category: P5D-COMMISSION-REFUND-ADJUSTMENT-IDEMPOTENCY-I)', () => {
  it('migration file exists and defines a partial unique index on unity_commission_adjustments.idempotency_key', () => {
    const sql = readMigration()
    expect(sql).toMatch(/create unique index if not exists unity_commission_adjustments_idempotency_key_unique\s+on public\.unity_commission_adjustments\(idempotency_key\)\s+where idempotency_key is not null/)
  })

  it('replaces create_unity_commission_adjustment with the same signature as before', () => {
    const sql = readMigration()
    expect(sql).toContain(
      'create or replace function public.create_unity_commission_adjustment(\n  p_actor_type text,\n  p_actor_id uuid,\n  p_commission_id uuid,\n  p_amount numeric,\n  p_reason text,\n  p_idempotency_key text default null\n)'
    )
  })

  it('the insert is now a guarded atomic claim -- INSERT ... ON CONFLICT (idempotency_key) ... DO NOTHING ... RETURNING, not a bare unconditional insert', () => {
    const body = functionBody(readMigration())
    expect(body).toMatch(/insert into public\.unity_commission_adjustments[\s\S]*?on conflict \(idempotency_key\) where idempotency_key is not null do nothing[\s\S]*?returning id into v_adjustment_id/)
  })

  it('a lost conflict is resolved by looking up the existing row and validating it, never by silently proceeding', () => {
    const body = functionBody(readMigration())
    expect(body).toMatch(/if v_adjustment_id is null and p_idempotency_key is not null then/)
    expect(body).toMatch(/select id, commission_id, amount, reason into v_existing\s+from public\.unity_commission_adjustments\s+where idempotency_key = p_idempotency_key/)
  })

  it('a replay with mismatched material parameters (commission_id, amount, or reason) fails closed', () => {
    const body = functionBody(readMigration())
    const guardIndex = body.search(/if v_existing\.commission_id is distinct from p_commission_id/)
    expect(guardIndex).toBeGreaterThanOrEqual(0)
    const guardStatement = body.slice(guardIndex, body.indexOf('end if;', guardIndex))
    expect(guardStatement).toMatch(/or round\(v_existing\.amount, 2\) is distinct from round\(p_amount, 2\)/)
    expect(guardStatement).toMatch(/or v_existing\.reason is distinct from p_reason/)
    expect(guardStatement).toMatch(/raise exception 'idempotency key already used with a different request'/)
  })

  it('a genuine replay returns the existing adjustment as a clean no-op and is marked, without calling the state transition again', () => {
    const body = functionBody(readMigration())
    const replayReturnIndex = body.search(/return jsonb_build_object\('commission_id', v_commission\.id, 'adjustment_id', v_existing\.id, 'status', v_commission\.status, 'replay', true\)/)
    expect(replayReturnIndex).toBeGreaterThanOrEqual(0)
    // The replay branch's own return statement must occur BEFORE the
    // shared _unity_commission_transition() call (i.e. inside the early
    // "if v_adjustment_id is null" block, which returns and exits the
    // function) -- a losing/replayed call must never reach a second
    // transition or a second history insert.
    const transitionCallIndex = body.search(/public\._unity_commission_transition\(/)
    expect(transitionCallIndex).toBeGreaterThan(replayReturnIndex)
  })

  it('the pre-existing admin-path idempotency_keys check is preserved unchanged, not replaced', () => {
    const body = functionBody(readMigration())
    expect(body).toMatch(/if p_idempotency_key is not null and p_actor_id is not null then[\s\S]*?from public\.idempotency_keys[\s\S]*?where merchant_id = p_actor_id and operation = 'create_unity_commission_adjustment' and idempotency_key = p_idempotency_key/)
  })

  it('the winning path is unchanged: still transitions to adjusted via the shared transition helper with the same allowed_from set', () => {
    const body = functionBody(readMigration())
    expect(body).toMatch(/public\._unity_commission_transition\(\s*p_commission_id, 'adjusted', array\['pending', 'held', 'earned'\]::public\.unity_commission_status\[\]/)
  })

  it('grants remain scoped to service_role only, same signature as before', () => {
    const sql = readMigration()
    expect(sql).toContain('revoke all on function public.create_unity_commission_adjustment(text, uuid, uuid, numeric, text, text) from public, anon, authenticated;')
    expect(sql).toContain('grant execute on function public.create_unity_commission_adjustment(text, uuid, uuid, numeric, text, text) to service_role;')
  })

  it('no unrelated DDL -- only the one index and the one function replacement', () => {
    const sql = readMigration()
    expect(sql).not.toMatch(/drop table|drop column|alter table.*drop/i)
    expect((sql.match(/create or replace function/g) ?? []).length).toBe(1)
    expect((sql.match(/create unique index/g) ?? []).length).toBe(1)
  })
})
