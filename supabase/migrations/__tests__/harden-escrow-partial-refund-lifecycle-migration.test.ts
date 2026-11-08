import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

/**
 * E25 migration-contract test for
 * 20261108101325_harden_escrow_partial_refund_lifecycle.sql.
 *
 * Scope: a fresh, exhaustive audit confirmed `partially_refunded` is
 * a genuine terminal-state defect -- public.refund_escrow_transaction
 * is the ONLY producer of that status anywhere in this codebase, and
 * no transition anywhere (release, refund, or RTB settlement) accepts
 * it as a source. No business rule exists for any of the 4 escrow
 * domains (sale/rental/barter/rent_to_buy) defining what a residual
 * balance should do next, and the refunded_amount field is non-
 * cumulative (designed for a single one-time refund, not a repeatable
 * sequence). Per this phase's own explicit default safety preference,
 * this selects fail-closed containment (classification D) over
 * inventing a lifecycle: refund_escrow_transaction now requires the
 * refund amount to equal the full held principal while the source
 * status is 'funded' (the only status it has ever accepted), making
 * 'partially_refunded' unreachable through its one and only producer.
 * Full-refund behavior is completely unchanged.
 *
 * LIMITATION, per this codebase's established convention: this test
 * parses SQL source text and asserts on its structure. It does not
 * execute against a live Postgres instance. This migration reaches
 * the live database only via the project's GitHub-integrated
 * Supabase workflow.
 */
const REPO_ROOT = join(__dirname, '../../..')
const MIGRATIONS_DIR = join(REPO_ROOT, 'supabase/migrations')
const MIGRATION_FILE = '20261108101325_harden_escrow_partial_refund_lifecycle.sql'
const MIGRATION_PATH = join(MIGRATIONS_DIR, MIGRATION_FILE)
const sql = readFileSync(MIGRATION_PATH, 'utf-8')
const codeOnly = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')
const normalized = codeOnly.replace(/\s+/g, ' ').trim()

function extractBody(src: string, marker: string): string {
  const idx = src.indexOf(marker)
  if (idx === -1) throw new Error(`marker not found: ${marker}`)
  const start = src.indexOf('as $$', idx)
  const end = src.indexOf('$$;', start)
  return src.slice(start + 5, end).trim()
}

const body = extractBody(sql, 'create or replace function public.refund_escrow_transaction(')

describe('20261108101325_harden_escrow_partial_refund_lifecycle.sql (category: ADMIN-CONTROL-CENTRE-BATCH-E25)', () => {
  it('1. redefines exactly one function -- refund_escrow_transaction -- and nothing else', () => {
    const defs = codeOnly.match(/create or replace function/gi) ?? []
    expect(defs).toHaveLength(1)
    expect(normalized).toMatch(/create or replace function public\.refund_escrow_transaction\(/)
  })

  it('2. requires the refund amount to exactly equal the full held principal while source status is funded', () => {
    expect(body).toMatch(/if p_amount <> v_escrow\.principal_amount then\s*\n\s*raise exception 'partial escrow refunds are not currently supported/)
  })

  it('3. the guard is checked after confirming status = funded but before any transition occurs', () => {
    const statusCheckIdx = body.indexOf("if v_escrow.status <> 'funded' then")
    const guardIdx = body.indexOf('if p_amount <> v_escrow.principal_amount then')
    const transitionIdx = body.indexOf('_escrow_transaction_transition(')
    expect(statusCheckIdx).toBeGreaterThan(-1)
    expect(guardIdx).toBeGreaterThan(statusCheckIdx)
    expect(transitionIdx).toBeGreaterThan(guardIdx)
  })

  it('4. the resulting status is always the literal \'refunded\' -- the dead "else partially_refunded" branch is removed, not left unreachable', () => {
    expect(body).toMatch(/_escrow_transaction_transition\(\s*\n\s*p_escrow_id, 'refunded', array\['funded'\]::escrow_status\[\],/)
    const bodyCodeOnly = body.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    expect(bodyCodeOnly).not.toMatch(/partially_refunded/)
    expect(bodyCodeOnly).not.toMatch(/v_new_status/)
  })

  it('5. the old ">" principal check is gone -- subsumed by the new "<>" check', () => {
    expect(body).not.toMatch(/if p_amount > v_escrow\.principal_amount then/)
  })

  it('6. every pre-existing guard (service_role auth, admin id required, reason required, positive amount, not-found, idempotency) is unchanged', () => {
    expect(body).toMatch(/if auth\.role\(\) <> 'service_role' then/)
    expect(body).toMatch(/if p_admin_id is null then/)
    expect(body).toMatch(/if p_reason is null or length\(trim\(p_reason\)\) = 0 then/)
    expect(body).toMatch(/if p_amount is null or p_amount <= 0 then/)
    expect(body).toMatch(/if v_escrow\.id is null then/)
    expect(body).toMatch(/where merchant_id = p_admin_id and operation = 'refund_escrow_transaction' and idempotency_key = p_idempotency_key/)
  })

  it('7. the return shape and idempotency-result caching are unchanged', () => {
    expect(body).toMatch(/jsonb_build_object\('escrow_transaction_id', v_escrow\.id, 'status', v_escrow\.status, 'refunded_at', v_escrow\.refunded_at, 'refunded_amount', v_escrow\.refunded_amount\)/)
    expect(body).toMatch(/insert into public\.idempotency_keys \(merchant_id, operation, idempotency_key, request_hash, result\)/)
  })

  it('8. preserves SECURITY DEFINER, search_path = public (not this phase\'s concern to harden), and the exact prior grants', () => {
    const header = normalized.slice(normalized.indexOf('create or replace function public.refund_escrow_transaction('), normalized.indexOf('as $$'))
    expect(header).toMatch(/security definer/i)
    expect(header).toMatch(/set search_path = public/i)
    expect(normalized).toMatch(/revoke all on function public\.refund_escrow_transaction\(uuid, uuid, numeric, text, text\) from public, anon, authenticated;/)
    expect(normalized).toMatch(/grant execute on function public\.refund_escrow_transaction\(uuid, uuid, numeric, text, text\) to service_role;/)
  })

  it('9. never touches release_escrow_transaction, _escrow_transaction_transition, _rent_to_buy_settle_escrow, or any payout/ledger function', () => {
    expect(codeOnly).not.toMatch(/function public\.(release_escrow_transaction|_escrow_transaction_transition|_rent_to_buy_settle_escrow|_merchant_payout_full_eligibility_block|_merchant_payout_still_safe_to_pay_block|create_merchant_payout|finalize_rent_to_buy_ownership|_rent_to_buy_settle_default_after_possession)\(/)
  })

  it('10. never touches ledger_entries, the escrow enum/table schema, RLS, triggers, or extensions -- redefinition only', () => {
    expect(codeOnly).not.toMatch(/create table|drop table|alter table/i)
    expect(codeOnly).not.toMatch(/create type|alter type|drop type/i)
    expect(codeOnly).not.toMatch(/create policy|drop policy|alter policy/i)
    expect(codeOnly).not.toMatch(/create trigger|drop trigger/i)
    expect(codeOnly).not.toMatch(/alter extension|create extension|drop extension/i)
    expect(codeOnly).not.toMatch(/ledger_entries/)
  })

  it('11. does not mutate any existing row -- no top-level INSERT/UPDATE/DELETE outside the function body', () => {
    const bodyStart = codeOnly.indexOf('as $$')
    const bodyEnd = codeOnly.indexOf('$$;')
    const outsideBody = codeOnly.slice(0, bodyStart) + codeOnly.slice(bodyEnd + 3)
    expect(outsideBody).not.toMatch(/\binsert into\b/i)
    expect(outsideBody).not.toMatch(/\bupdate\s+public\./i)
    expect(outsideBody).not.toMatch(/\bdelete from\b/i)
  })

  it('12. no dynamic SQL exists anywhere in this migration', () => {
    expect(codeOnly).not.toMatch(/\bEXECUTE\s+(format|'|")/i)
    expect(codeOnly).not.toMatch(/quote_ident|quote_literal/)
  })

  it('13. is forward-only -- sorts after every pre-existing migration, no historical file modified', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'))
    expect(files).toContain(MIGRATION_FILE)
    const earlier = files.filter((f) => f !== MIGRATION_FILE && f < MIGRATION_FILE)
    expect(earlier.length).toBeGreaterThan(0)
  })
})

describe('pre-existing fact check: no transition anywhere in migration history accepts partially_refunded as a source state', () => {
  it('14. zero occurrences of partially_refunded inside any escrow_status[] allowed-from array, and no row-selecting query treats it as a source to act on (read-only reporting/count aggregations are expected and excluded)', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'))
    for (const f of files) {
      const content = readFileSync(join(MIGRATIONS_DIR, f), 'utf-8')
      // Escrow-specific: no allowed-from array for an escrow_status[] transition ever includes it.
      expect(content, f).not.toMatch(/array\[[^\]]*'partially_refunded'[^\]]*\]::escrow_status\[\]/)
      // Escrow-specific: no SELECT ... FOR UPDATE (the row-locking shape every real
      // transition uses) ever targets this status. Read-only count(*)/stats
      // aggregations (e.g. the admin overview's combined refunded+partially_refunded
      // display bucket) legitimately reference it and are not matched here.
      expect(content, f).not.toMatch(/from public\.escrow_transactions[^;]*'partially_refunded'[^;]*for update/i)
    }
  })

  it('15. public._escrow_transaction_transition\'s refunded_amount assignment is a SET, not an accumulator -- confirming it was designed for a single one-time refund', () => {
    const transitionFile = join(MIGRATIONS_DIR, '20260825000003_escrow_rpcs.sql')
    const content = readFileSync(transitionFile, 'utf-8')
    expect(content).toMatch(/refunded_amount = case when p_new_status in \('refunded', 'partially_refunded'\) then coalesce\(p_refund_amount, refunded_amount\) else refunded_amount end/)
    expect(content).not.toMatch(/refunded_amount \+ p_refund_amount/)
  })
})
