import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

/**
 * P5D-EXPIRE-UNPAID-NOTIFICATION-RECOVERY-F1: migration-contract test for
 * 20261020000000_payment_expired_notification_recovery_candidates.sql.
 *
 * IMPORTANT LIMITATION, stated explicitly per this codebase's own
 * established convention (see reconcile-adjustment-idempotency-migration.test.ts
 * and siblings): this test parses the migration's SQL source text and
 * asserts on its structure. It does NOT execute the SQL against a real
 * Postgres instance and does NOT prove genuine query-planner behavior
 * (e.g. that an index-driven anti-join is actually chosen, or its real
 * cost) -- no live database is available to this test environment. What
 * it DOES verify directly from the text: the NOT EXISTS predicate for
 * each recipient role is evaluated inside the subquery that is UNION
 * ALL'd, strictly BEFORE the outer ORDER BY/LIMIT; no WHERE clause
 * anywhere in the function compares payment_expired_at against any
 * now()/interval-derived cutoff (no permanent age horizon); the function
 * is read-only; and authorization/grants match this codebase's existing
 * service-role-only RPC convention. A companion test
 * (dispatch-expiry.test.ts) exercises the real application-level
 * consumer against a fake admin client whose `rpc()` re-implements this
 * exact contract in memory.
 */

const MIGRATION_PATH = resolve(__dirname, '../../../../supabase/migrations/20261020000000_payment_expired_notification_recovery_candidates.sql')

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

describe('20261020000000_payment_expired_notification_recovery_candidates.sql (category: P5D-EXPIRE-UNPAID-NOTIFICATION-RECOVERY-F1)', () => {
  it('migration file exists and defines find_missing_payment_expired_notifications with the expected signature', () => {
    const sql = readMigration()
    expect(sql).toContain('create or replace function public.find_missing_payment_expired_notifications(p_limit integer default 100)')
    expect(sql).toMatch(/returns table \(\s*booking_id uuid,\s*recipient_role text,\s*recipient_user_id uuid,\s*payment_expired_at timestamptz\s*\)/)
  })

  it('is service-role-gated, security definer, consistent with this codebase\'s existing internal-RPC convention', () => {
    const sql = readMigration()
    const body = functionBody(sql)
    expect(sql).toMatch(/language plpgsql\s*\n?\s*stable\s*\n?\s*security definer\s*\n?\s*set search_path = public/)
    expect(body).toMatch(/if auth\.role\(\) <> 'service_role' then\s*\n\s*raise exception 'not authorized';\s*\n\s*end if;/)
  })

  it('evaluates a NOT EXISTS anti-join against email_deliveries independently for the renter and the merchant', () => {
    const body = functionBody(readMigration())
    const notExistsOccurrences = body.match(/not exists \(/g) ?? []
    expect(notExistsOccurrences.length).toBe(2)
    expect(body).toMatch(/recipient_user_id = b\.renter_id/)
    expect(body).toMatch(/recipient_user_id = b\.merchant_id/)
    // Both anti-joins check existence scoped to this exact notification's
    // business identity (entity type/id + event type + recipient) --
    // never merely "does this booking have any email at all".
    expect(body).toMatch(/ed\.related_entity_type = 'booking'[\s\S]{0,120}ed\.related_entity_id = b\.id[\s\S]{0,120}ed\.event_type = 'booking\.payment_expired'/)
  })

  it('the unresolved predicate is evaluated BEFORE limit -- both NOT EXISTS subqueries and the UNION ALL occur earlier in the text than the LIMIT clause', () => {
    const body = functionBody(readMigration())
    const firstNotExists = body.indexOf('not exists (')
    const secondNotExists = body.indexOf('not exists (', firstNotExists + 1)
    const unionAllIndex = body.indexOf('union all')
    const limitIndex = body.search(/limit greatest/)

    expect(firstNotExists).toBeGreaterThanOrEqual(0)
    expect(secondNotExists).toBeGreaterThan(firstNotExists)
    expect(unionAllIndex).toBeGreaterThan(firstNotExists)
    expect(unionAllIndex).toBeLessThan(secondNotExists)
    expect(limitIndex).toBeGreaterThan(secondNotExists)
  })

  it('applies no permanent age cutoff -- no predicate anywhere compares payment_expired_at against now() or an interval-derived cutoff', () => {
    const body = functionBody(readMigration())
    expect(body).not.toMatch(/payment_expired_at\s*[<>]/)
    expect(body).not.toMatch(/now\(\)\s*-\s*interval/)
    expect(body).not.toMatch(/lookback/i)
  })

  it('orders deterministically by payment_expired_at ascending, then booking_id, then recipient_role', () => {
    const body = functionBody(readMigration())
    expect(body).toMatch(/order by missing\.payment_expired_at asc, missing\.booking_id asc, missing\.recipient_role asc/)
  })

  it('is read-only -- never writes to bookings or email_deliveries', () => {
    const sql = readMigration()
    expect(sql).not.toMatch(/insert into|update\s+public\.(bookings|email_deliveries)|delete from/i)
  })

  it('grants remain scoped to service_role only', () => {
    const sql = readMigration()
    expect(sql).toContain('revoke all on function public.find_missing_payment_expired_notifications(integer) from public, anon, authenticated;')
    expect(sql).toContain('grant execute on function public.find_missing_payment_expired_notifications(integer) to service_role;')
  })

  it('no unrelated DDL -- only the one function definition and its grants', () => {
    const sql = readMigration()
    expect(sql).not.toMatch(/drop table|drop column|alter table.*drop|create table|create index/i)
    expect((sql.match(/create or replace function/g) ?? []).length).toBe(1)
  })
})
