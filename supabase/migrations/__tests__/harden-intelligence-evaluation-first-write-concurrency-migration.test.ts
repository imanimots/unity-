import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const REPO_ROOT = join(__dirname, '../../..')
const MIGRATION_PATH = join(REPO_ROOT, 'supabase/migrations/20261101150000_harden_intelligence_evaluation_first_write_concurrency.sql')
const sql = readFileSync(MIGRATION_PATH, 'utf-8')
const codeOnly = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')
const normalized = codeOnly.replace(/\s+/g, ' ')
const fnStart = codeOnly.indexOf('create or replace function public.record_intelligence_evaluation(')
const fnEnd = codeOnly.indexOf('$$;', fnStart) + 3
const fnBody = codeOnly.slice(fnStart, fnEnd)

describe('20261101150000_harden_intelligence_evaluation_first_write_concurrency.sql (E12)', () => {
  it('1. redefines only the exact record_intelligence_evaluation signature', () => {
    expect((codeOnly.match(/create or replace function/gi) ?? [])).toHaveLength(1)
    expect(normalized).toContain('create or replace function public.record_intelligence_evaluation( p_admin_id uuid, p_insight_fingerprint text, p_fingerprint_version integer, p_rule_id text, p_evaluation text, p_reason_code text default null ) returns public.admin_intelligence_evaluations')
  })

  it('2. preserves SECURITY DEFINER', () => {
    expect(fnBody).toMatch(/security\s+definer/i)
  })

  it('3. preserves a fixed search_path', () => {
    expect(fnBody).toMatch(/set\s+search_path\s*=\s*public/i)
  })

  it('4. acquires a transaction-scoped advisory lock', () => {
    expect(fnBody).toMatch(/pg_catalog\.pg_advisory_xact_lock\s*\(/i)
  })

  it('5. keys the advisory lock from the complete logical unique key', () => {
    expect(normalized).toContain("pg_catalog.hashtextextended( p_admin_id::text || ':' || p_insight_fingerprint, 0 )")
  })

  it('6. acquires the advisory lock before reading previous_evaluation', () => {
    const lockIndex = fnBody.indexOf('pg_catalog.pg_advisory_xact_lock')
    const readIndex = fnBody.indexOf('select evaluation into v_previous')
    expect(lockIndex).toBeGreaterThan(-1)
    expect(readIndex).toBeGreaterThan(lockIndex)
  })

  it('7. retains E4 SELECT FOR UPDATE after the logical-key lock', () => {
    expect(fnBody).toMatch(/select evaluation into v_previous[\s\S]*?where admin_user_id = p_admin_id and insight_fingerprint = p_insight_fingerprint\s*for update;/i)
  })

  it('8. preserves current-state upsert identity', () => {
    expect(fnBody).toMatch(/on conflict \(admin_user_id, insight_fingerprint\) do update set/i)
  })

  it('9. preserves one current-state write and one history write in the same function', () => {
    expect((fnBody.match(/insert into public\.admin_intelligence_evaluations/g) ?? [])).toHaveLength(1)
    expect((fnBody.match(/insert into public\.admin_intelligence_evaluation_history/g) ?? [])).toHaveLength(1)
  })

  it('10. preserves previous_evaluation in immutable history transitions', () => {
    expect(fnBody).toMatch(/insert into public\.admin_intelligence_evaluation_history[\s\S]*?v_previous, p_evaluation, p_reason_code/i)
  })

  it('11. preserves service_role-only RPC execution', () => {
    expect(normalized).toContain('revoke all on function public.record_intelligence_evaluation(uuid, text, integer, text, text, text) from public, anon, authenticated;')
    expect(normalized).toContain('grant execute on function public.record_intelligence_evaluation(uuid, text, integer, text, text, text) to service_role;')
  })

  it('12. makes no RLS or policy changes', () => {
    expect(codeOnly).not.toMatch(/create\s+policy|drop\s+policy|alter\s+policy|row\s+level\s+security/i)
  })

  it('13. makes no table grants or direct table permission changes', () => {
    expect(codeOnly).not.toMatch(/grant\s+(select|insert|update|delete|all)\s+on\s+table/i)
    expect(codeOnly).not.toMatch(/revoke\s+.+\s+on\s+table/i)
  })

  it('14. makes no trigger, table, view, or schema DDL changes', () => {
    expect(codeOnly).not.toMatch(/create\s+trigger|drop\s+trigger|alter\s+trigger|create\s+table|alter\s+table|drop\s+table|create\s+view|alter\s+view|drop\s+view|create\s+schema|alter\s+schema|drop\s+schema/i)
  })

  it('15. introduces no dynamic SQL', () => {
    expect(fnBody).not.toMatch(/\bexecute\b|format\s*\(|quote_ident|quote_literal/i)
  })
})
