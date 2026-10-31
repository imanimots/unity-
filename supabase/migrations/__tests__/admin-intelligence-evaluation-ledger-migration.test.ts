import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * E3 migration-contract test for
 * 20261031090000_admin_intelligence_evaluation_ledger.sql.
 *
 * LIMITATION, stated explicitly per this codebase's own established
 * convention (see booking-condition-evidence-migration.test.ts and
 * siblings): this test parses the migration's SQL source text and
 * asserts on its structure. It does NOT execute the SQL against a real
 * Postgres instance and does NOT prove RLS/grant enforcement live -- no
 * live database is available to this test environment, and this
 * migration has not been applied anywhere (E3 explicitly does not apply
 * it -- source file only).
 */
const REPO_ROOT = join(__dirname, '../../..')
const MIGRATION_PATH = join(REPO_ROOT, 'supabase/migrations/20261031090000_admin_intelligence_evaluation_ledger.sql')
const sql = readFileSync(MIGRATION_PATH, 'utf-8')

const EVALUATION_CHECK = `evaluation in ('useful', 'not_useful', 'incorrect', 'needs_more_data', 'needs_investigation')`

describe('20261031090000_admin_intelligence_evaluation_ledger.sql (category: ADMIN-CONTROL-CENTRE-BATCH-E3)', () => {
  it('1. creates admin_intelligence_evaluations with the required columns', () => {
    expect(sql).toMatch(/create table if not exists public\.admin_intelligence_evaluations/)
    expect(sql).toMatch(/insight_fingerprint\s+text not null check \(insight_fingerprint ~ '\^\[0-9a-f\]\{64\}\$'\)/)
    expect(sql).toMatch(/fingerprint_version\s+integer not null default 1/)
    expect(sql).toMatch(/rule_id\s+text not null/)
    expect(sql).toMatch(new RegExp(`evaluation\\s+text not null check \\(${EVALUATION_CHECK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`))
    expect(sql).toMatch(/admin_user_id\s+uuid not null references public\.profiles\(id\)/)
    expect(sql).toMatch(/created_at\s+timestamptz not null default now\(\)/)
    expect(sql).toMatch(/updated_at\s+timestamptz not null default now\(\)/)
  })

  it('2. the evaluation CHECK constraint constrains to exactly the 5-value taxonomy, no more no less', () => {
    const match = sql.match(/evaluation\s+text not null check \(evaluation in \(([^)]*)\)\)/)
    expect(match).toBeTruthy()
    const values = (match?.[1] ?? '').split(',').map((v) => v.trim().replace(/'/g, ''))
    expect(new Set(values)).toEqual(new Set(['useful', 'not_useful', 'incorrect', 'needs_more_data', 'needs_investigation']))
  })

  it('3. reason_code is optional and, when present, constrained to the fixed reason-code enum', () => {
    expect(sql).toMatch(/reason_code\s+text check \(reason_code is null or reason_code in \('NOT_ENOUGH_CONTEXT', 'WRONG_INTERPRETATION', 'STALE_SIGNAL', 'EXPECTED_BEHAVIOR', 'DUPLICATE_SIGNAL', 'OTHER'\)\)/)
  })

  it('4. exactly one current row per (admin_user_id, insight_fingerprint) is enforced by a UNIQUE constraint', () => {
    expect(sql).toMatch(/constraint admin_intelligence_evaluations_admin_fingerprint_uniq unique \(admin_user_id, insight_fingerprint\)/)
  })

  it('5. does NOT persist raw insight text or evidence -- no title/summary/rationale/recommendation/evidence column anywhere on either table', () => {
    // Strip `--` comment lines first -- the migration's own design-rationale
    // prose (in comments) legitimately names these fields to explain why
    // they are deliberately excluded from the actual DDL below.
    const sqlWithoutComments = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')
    expect(sqlWithoutComments).not.toMatch(/\btitle\b|\bsummary\b|\brationale\b|\brecommendation\b|\bevidence\b/)
  })

  it('6. RLS is enabled on admin_intelligence_evaluations with an admin-only read policy and no client write policy', () => {
    expect(sql).toMatch(/alter table public\.admin_intelligence_evaluations enable row level security/)
    expect(sql).toMatch(/create policy "admin_intelligence_evaluations: admin read"[\s\S]*?profiles\.role = 'admin'/)
    const policyBlocks = sql.match(/create policy "admin_intelligence_evaluations:[^"]*"/g) ?? []
    expect(policyBlocks).toHaveLength(1)
    // Scoped to just THIS policy's own statement (up to its closing `;`)
    // -- an unbounded `[\s\S]*?` here would also match unrelated SQL much
    // later in the file (e.g. the RPC's own `for update` row lock),
    // producing a false positive/negative unrelated to this policy.
    const start = sql.indexOf('create policy "admin_intelligence_evaluations:')
    const policyStatement = sql.slice(start, sql.indexOf(';', start))
    expect(policyStatement).not.toMatch(/for (insert|update|delete)/)
  })

  it('7. creates the immutable admin_intelligence_evaluation_history audit table', () => {
    expect(sql).toMatch(/create table if not exists public\.admin_intelligence_evaluation_history/)
    expect(sql).toMatch(/previous_evaluation\s+text check \(previous_evaluation is null or previous_evaluation in/)
    expect(sql).toMatch(/new_evaluation\s+text not null check \(new_evaluation in/)
  })

  it('8. the history table is immutable -- a before update/delete trigger executes the existing prevent_row_mutation() function', () => {
    expect(sql).toMatch(/create trigger admin_intelligence_evaluation_history_immutable\s*\n\s*before update or delete on public\.admin_intelligence_evaluation_history\s*\n\s*for each row execute function public\.prevent_row_mutation\(\)/)
  })

  it('9. RLS is enabled on the history table with an admin-only read policy and no client write policy', () => {
    expect(sql).toMatch(/alter table public\.admin_intelligence_evaluation_history enable row level security/)
    const policyBlocks = sql.match(/create policy "admin_intelligence_evaluation_history:[^"]*"/g) ?? []
    expect(policyBlocks).toHaveLength(1)
    // Scoped to just THIS policy's own statement -- see test 6's comment.
    const start = sql.indexOf('create policy "admin_intelligence_evaluation_history:')
    const policyStatement = sql.slice(start, sql.indexOf(';', start))
    expect(policyStatement).not.toMatch(/for (insert|update|delete)/)
  })

  it('10. record_intelligence_evaluation is SECURITY DEFINER with a locked-down search_path', () => {
    expect(sql).toMatch(/create or replace function public\.record_intelligence_evaluation\(/)
    const fnBody = sql.slice(sql.indexOf('create or replace function public.record_intelligence_evaluation('))
    expect(fnBody.slice(0, 400)).toMatch(/security definer/)
    expect(fnBody.slice(0, 400)).toMatch(/set search_path = public/)
  })

  it('11. anon and authenticated (and PUBLIC) are revoked from the RPC; only service_role may execute it', () => {
    expect(sql).toMatch(/revoke all on function public\.record_intelligence_evaluation\(uuid, text, integer, text, text, text\) from public, anon, authenticated;/)
    expect(sql).toMatch(/grant execute on function public\.record_intelligence_evaluation\(uuid, text, integer, text, text, text\) to service_role;/)
  })

  it('12. the RPC upserts the current-state row keyed on (admin_user_id, insight_fingerprint) -- idempotent, not append-only', () => {
    expect(sql).toMatch(/on conflict \(admin_user_id, insight_fingerprint\) do update set/)
  })

  it('13. the RPC captures the previous evaluation before upserting, and writes it into the history row -- the audit trail records the actual transition, not just the new value', () => {
    const fnBody = sql.slice(sql.indexOf('create or replace function public.record_intelligence_evaluation('), sql.indexOf('$$;') + 3)
    expect(fnBody).toMatch(/select evaluation into v_previous\s*\n\s*from public\.admin_intelligence_evaluations\s*\n\s*where admin_user_id = p_admin_id and insight_fingerprint = p_insight_fingerprint/)
    expect(fnBody).toMatch(/insert into public\.admin_intelligence_evaluation_history[\s\S]*?v_previous, p_evaluation/)
  })

  it('14. the current-state upsert and the history insert happen inside the same function body (one transaction, atomic) -- not two separate RPCs', () => {
    const fnBody = sql.slice(sql.indexOf('create or replace function public.record_intelligence_evaluation('), sql.indexOf('$$;') + 3)
    expect((fnBody.match(/insert into public\.admin_intelligence_evaluations/g) ?? []).length).toBe(1)
    expect((fnBody.match(/insert into public\.admin_intelligence_evaluation_history/g) ?? []).length).toBe(1)
    expect((sql.match(/create or replace function/g) ?? []).length).toBe(1)
  })

  it('15. no unrelated DDL -- exactly two new tables, no ALTER/DROP of any pre-existing table other than the trigger drop-if-exists on its own new table', () => {
    expect((sql.match(/create table if not exists/g) ?? []).length).toBe(2)
    expect(sql).not.toMatch(/alter table public\.profiles/)
    expect(sql).not.toMatch(/drop table|drop column/i)
  })

  it('16. does not reference any marketplace entity table (bookings/orders/listings/disputes/payments) -- this ledger is Intelligence-metadata only', () => {
    expect(sql).not.toMatch(/references public\.(bookings|orders|listings|disputes|payments|merchant_payouts)\(/)
  })

  it('17. E4: the previous-evaluation read locks the row (FOR UPDATE) before the upsert, so two genuinely concurrent calls for the same (admin_user_id, insight_fingerprint) cannot both read the same stale "previous" value and corrupt the audit transition history', () => {
    const fnBody = sql.slice(sql.indexOf('create or replace function public.record_intelligence_evaluation('), sql.indexOf('$$;') + 3)
    expect(fnBody).toMatch(/select evaluation into v_previous[\s\S]*?where admin_user_id = p_admin_id and insight_fingerprint = p_insight_fingerprint\s*\n\s*for update;/)
  })
})
