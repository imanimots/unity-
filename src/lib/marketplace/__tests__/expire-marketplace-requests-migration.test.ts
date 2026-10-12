import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

/**
 * P5D-ROUTE-HARDEN-I: migration-contract test for
 * 20261012000000_harden_marketplace_expiry_claim.sql.
 *
 * IMPORTANT LIMITATION, stated explicitly per this phase's own
 * instruction: this test parses the migration's SQL source text and
 * asserts on its structure (the presence and ordering of the atomic
 * claim mechanism). It does NOT execute the SQL against a real
 * Postgres instance and does NOT prove actual concurrent-transaction
 * locking behavior -- no live database is available to this test
 * environment. This is the same convention already used throughout
 * this codebase's other migration-contract tests (see
 * rtb-payoff-snapshot-migration.test.ts and siblings) for exactly this
 * reason. The genuine safety property (two concurrent Postgres
 * transactions cannot both claim the same row under `FOR UPDATE SKIP
 * LOCKED`) is a well-established, documented Postgres guarantee that
 * this test corroborates structurally, not one it independently proves
 * by execution.
 */

const MIGRATION_PATH = resolve(__dirname, '../../../../supabase/migrations/20261012000000_harden_marketplace_expiry_claim.sql')

function readMigration(): string {
  return readFileSync(MIGRATION_PATH, 'utf8')
}

/** Extracts just the function body (between the `as $$` / `$$;` markers) so assertions never match the header comment's prose. */
function functionBody(sql: string): string {
  const start = sql.indexOf('as $$')
  const end = sql.indexOf('$$;', start)
  expect(start, 'could not locate function body start').toBeGreaterThanOrEqual(0)
  expect(end, 'could not locate function body end').toBeGreaterThan(start)
  return sql.slice(start, end)
}

describe('20261012000000_harden_marketplace_expiry_claim.sql (category: P5D-ROUTE-HARDEN-I)', () => {
  it('migration file exists and defines expire_marketplace_requests', () => {
    const sql = readMigration()
    expect(sql).toContain('create or replace function public.expire_marketplace_requests(p_limit int default 200)')
  })

  it('uses a per-row FOR UPDATE SKIP LOCKED claim cursor, not a batch SELECT', () => {
    const body = functionBody(readMigration())
    expect(body).toMatch(/for\s+update\s+skip\s+locked/i)
    // The prior, unsafe batch pattern collected ids into an array before
    // any update -- confirm that shape is gone.
    expect(body).not.toMatch(/array_agg\(id\)/i)
  })

  it('preserves the service_role authorization guard', () => {
    const body = functionBody(readMigration())
    expect(body).toMatch(/auth\.role\(\)\s*<>\s*'service_role'/)
  })

  it('captures the row status INSIDE the loop (the true pre-update value), never by re-reading after the update', () => {
    const body = functionBody(readMigration())
    // The claimed cursor row's own `status` column must appear in the
    // history insert's values -- not a second SELECT against
    // marketplace_requests after the UPDATE (the exact bug being fixed).
    const historyInsertIndex = body.search(/insert into public\.marketplace_request_history/i)
    expect(historyInsertIndex).toBeGreaterThanOrEqual(0)
    const historyInsertStatement = body.slice(historyInsertIndex, body.indexOf(';', historyInsertIndex) + 1)
    expect(historyInsertStatement).toMatch(/v_row\.status::text/)
    // Must not re-select from marketplace_requests to discover
    // previous_status (that re-read, post-update, is exactly what
    // produced the wrong value before this fix).
    const afterFirstUpdate = body.slice(body.search(/update public\.marketplace_requests/i))
    expect(afterFirstUpdate).not.toMatch(/select\s+id,\s*status\s+from\s+public\.marketplace_requests\s+where\s+id\s*=\s*any/i)
  })

  it('the update and history insert happen inside the same claim loop, one row at a time', () => {
    const body = functionBody(readMigration())
    const loopStart = body.search(/for\s+v_row\s+in/i)
    const loopEnd = body.search(/end\s+loop/i)
    expect(loopStart).toBeGreaterThanOrEqual(0)
    expect(loopEnd).toBeGreaterThan(loopStart)
    const loopBody = body.slice(loopStart, loopEnd)
    expect(loopBody).toMatch(/update public\.marketplace_requests set status = 'date_passed' where id = v_row\.id/)
    expect(loopBody).toMatch(/insert into public\.marketplace_request_history/)
  })

  it('return shape is unchanged: expired_count only, no new fields introduced', () => {
    const body = functionBody(readMigration())
    const returnStatement = body.slice(body.lastIndexOf('return'))
    expect(returnStatement).toMatch(/jsonb_build_object\('expired_count', v_expired_count\)/)
  })

  it('grants remain scoped to service_role only, same signature as before', () => {
    const sql = readMigration()
    expect(sql).toContain('revoke all on function public.expire_marketplace_requests(int) from public, anon, authenticated;')
    expect(sql).toContain('grant execute on function public.expire_marketplace_requests(int) to service_role;')
  })
})
