import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

/**
 * E23 migration-contract test for
 * 20261107175026_contain_escrow_refund_payout_desync.sql.
 *
 * Scope: a fresh audit of the post-dispute financial lifecycle found
 * two independent issues. Only one has a safe, deterministic fix
 * without fabricating business logic: the admin escrow-refund path
 * (POST /api/admin/escrow/[id]/refund -> refundEscrowTransaction() ->
 * public.refund_escrow_transaction()) updates only escrow_transactions
 * and escrow_transaction_history -- never public.payments,
 * public.refunds, public.ledger_entries, or public.merchant_payouts --
 * so a booking whose escrow was already refunded remains fully payout-
 * eligible. This migration extends the booking branch of both payout
 * safety gates (full-eligibility, checked before pending/failed ->
 * processing; still-safe-to-pay, checked before processing -> paid)
 * to also treat a refunded/partially-refunded escrow_transactions row
 * as the same 'source_payment_issue' category the existing
 * payments.status check already returns -- the same policy, applied
 * consistently to the second refund-recording table.
 *
 * The other finding (no structured financial disposition exists for
 * favor_raiser / mutual_agreement / manual_settlement, so a booking
 * resolved any of those ways is payout- and escrow-release-eligible
 * with zero technical distinction from favor_respondent) is NOT fixed
 * here -- it requires a product decision this codebase has never
 * made, and fabricating one would violate this phase's own explicit
 * instruction not to invent business logic. See this phase's final
 * report.
 *
 * LIMITATION, per this codebase's established convention: this test
 * parses SQL source text and asserts on its structure. It does not
 * execute against a live Postgres instance. This migration reaches
 * the live database only via the project's GitHub-integrated
 * Supabase workflow.
 */
const REPO_ROOT = join(__dirname, '../../..')
const MIGRATIONS_DIR = join(REPO_ROOT, 'supabase/migrations')
const MIGRATION_FILE = '20261107175026_contain_escrow_refund_payout_desync.sql'
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

function stripComments(src: string): string {
  return src.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').replace(/\s+/g, ' ').trim()
}

describe('20261107175026_contain_escrow_refund_payout_desync.sql (category: ADMIN-CONTROL-CENTRE-BATCH-E23)', () => {
  it('1. redefines exactly the two booking-branch payout safety gates, nothing else', () => {
    const defs = codeOnly.match(/create or replace function/gi) ?? []
    expect(defs).toHaveLength(2)
    expect(normalized).toMatch(/create or replace function public\._merchant_payout_full_eligibility_block\(p_payout public\.merchant_payouts\)/)
    expect(normalized).toMatch(/create or replace function public\._merchant_payout_still_safe_to_pay_block\(p_payout public\.merchant_payouts\)/)
  })

  it('2. both functions check for a refunded/partially-refunded escrow_transactions row scoped to booking_id', () => {
    const matches = codeOnly.match(/select 1 from public\.escrow_transactions\s*\n\s*where booking_id = p_payout\.booking_id and status in \('refunded', 'partially_refunded'\)/g) ?? []
    expect(matches).toHaveLength(2)
  })

  it('3. the new check returns the same category the existing payment-status check already uses', () => {
    const fullBody = extractBody(sql, 'create or replace function public._merchant_payout_full_eligibility_block')
    const safeBody = extractBody(sql, 'create or replace function public._merchant_payout_still_safe_to_pay_block')
    for (const body of [fullBody, safeBody]) {
      const escrowCheckIdx = body.indexOf('escrow_transactions')
      const window = body.slice(escrowCheckIdx, escrowCheckIdx + 200)
      expect(window).toMatch(/return 'source_payment_issue';/)
    }
  })

  it('4. preserves SECURITY DEFINER and search_path = public (unchanged -- not E23\'s concern) for both functions', () => {
    for (const name of ['_merchant_payout_full_eligibility_block', '_merchant_payout_still_safe_to_pay_block']) {
      const defIdx = codeOnly.search(new RegExp(`create or replace function public\\.${name}\\(`))
      const header = codeOnly.slice(defIdx, codeOnly.indexOf('as $$', defIdx))
      expect(header, `${name}: missing security definer`).toMatch(/security definer/i)
      expect(header, `${name}: search_path unexpectedly changed`).toMatch(/set search_path = public/i)
    }
  })

  it('5. preserves the exact existing grants -- service_role only, no widening', () => {
    for (const name of ['_merchant_payout_full_eligibility_block', '_merchant_payout_still_safe_to_pay_block']) {
      expect(normalized).toMatch(new RegExp(`revoke all on function public\\.${name}\\(public\\.merchant_payouts\\) from public, anon, authenticated;`))
      expect(normalized).toMatch(new RegExp(`grant execute on function public\\.${name}\\(public\\.merchant_payouts\\) to service_role;`))
    }
  })

  it('6. body-diff: removing exactly the new escrow check from this migration\'s bodies reproduces the current live RTB bodies exactly', () => {
    const RTB_FILE = join(MIGRATIONS_DIR, '20260821183600_rtb_v2_rpcs.sql')
    const rtbContent = readFileSync(RTB_FILE, 'utf-8')
    const ESCROW_CHECK = "if exists ( select 1 from public.escrow_transactions where booking_id = p_payout.booking_id and status in ('refunded', 'partially_refunded') ) then return 'source_payment_issue'; end if; "
    for (const name of ['_merchant_payout_full_eligibility_block', '_merchant_payout_still_safe_to_pay_block']) {
      const before = stripComments(extractBody(rtbContent, `create or replace function public.${name}(`))
      const after = stripComments(extractBody(sql, `create or replace function public.${name}(`))
      expect(after.length, `${name}: body did not grow`).toBeGreaterThan(before.length)
      expect(after.replace(ESCROW_CHECK, ''), `${name}: unexpected diff beyond the escrow check`).toBe(before)
    }
  })

  it('7. the RTB branch (rent_to_buy_agreement_id) of both functions is left untouched -- scoped to booking only', () => {
    const fullBody = extractBody(sql, 'create or replace function public._merchant_payout_full_eligibility_block')
    const rtbBranch = fullBody.slice(0, fullBody.indexOf('if p_payout.booking_id is null'))
    expect(rtbBranch).not.toMatch(/escrow_transactions/)
  })

  it('8. never touches payout creation, candidate selection, mark_payout_failed, or any other function', () => {
    expect(codeOnly).not.toMatch(/_payout_reconcile_missing_candidates|create_merchant_payout|mark_payout_failed|mark_payout_processing|retry_payout|mark_payout_paid/)
  })

  it('9. never mutates ledger_entries, payments, refunds, or merchant_payouts data -- DDL/function redefinition only', () => {
    expect(codeOnly).not.toMatch(/^\s*insert into\b/im)
    expect(codeOnly).not.toMatch(/^\s*update\s+public\./im)
    expect(codeOnly).not.toMatch(/^\s*delete from\b/im)
  })

  it('10. never touches escrow_transaction_completion_block, dispute_block, resolve_dispute, or ledger_entries_immutable', () => {
    expect(codeOnly).not.toMatch(/_escrow_transaction_completion_block|_escrow_transaction_dispute_block|resolve_dispute|ledger_entries_immutable/)
  })

  it('11. never touches RLS, policies, tables, triggers, or extensions', () => {
    expect(codeOnly).not.toMatch(/create policy|drop policy|alter policy/i)
    expect(codeOnly).not.toMatch(/create table|drop table|alter table/i)
    expect(codeOnly).not.toMatch(/create trigger|drop trigger/i)
    expect(codeOnly).not.toMatch(/alter extension|create extension|drop extension/i)
    expect(codeOnly).not.toMatch(/enable row level security|disable row level security/i)
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

describe('pre-existing fact check: create_refund has zero production call sites and is never invoked by resolve_dispute', () => {
  const RESOLVE_FILE = join(MIGRATIONS_DIR, '20260904000003_dispute_resolve_restore_booking_all_outcomes.sql')

  it('14. the current authoritative resolve_dispute body never references create_refund, refund_escrow_transaction, payments, refunds, ledger_entries, escrow_transactions, or merchant_payouts', () => {
    const content = readFileSync(RESOLVE_FILE, 'utf-8')
    const body = extractBody(content, 'create or replace function public.resolve_dispute')
    expect(body).not.toMatch(/create_refund|refund_escrow_transaction|public\.payments|public\.refunds|public\.ledger_entries|public\.escrow_transactions|public\.merchant_payouts/)
  })
})
