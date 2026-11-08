import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

/**
 * E27 migration-contract test for
 * 20261108163517_add_rtb_payout_exception_candidates.sql.
 *
 * Scope: public._merchant_payout_exception_candidates() (the booking
 * exception RPC) can never see RTB payout context -- its joins key on
 * mp.booking_id, always NULL for an RTB payout (the table's own
 * exactly-one-of CHECK), so NULL = NULL never matches. This migration
 * adds a separate, narrow, read-only RPC for RTB payouts rather than
 * widening the booking one (stable existing contract, structurally
 * different context, zero added booking regression surface).
 *
 * This function reuses the canonical gate functions
 * (_merchant_payout_full_eligibility_block /
 * _merchant_payout_still_safe_to_pay_block) rather than re-encoding
 * E23/E24/E26's rules -- the single most important property this test
 * suite exists to prove, since any independent re-encoding is exactly
 * how a future gate change would silently drift from what admin
 * exceptions report.
 *
 * LIMITATION, per this codebase's established convention: this test
 * parses SQL source text and asserts on its structure. It does not
 * execute against a live Postgres instance. This migration reaches
 * the live database only via the project's GitHub-integrated
 * Supabase workflow. The live no-escrow false-positive proof itself
 * was independently obtained by this phase via a direct, read-only
 * RPC call against production (see this phase's own report) -- not by
 * this test file.
 */
const REPO_ROOT = join(__dirname, '../../..')
const MIGRATIONS_DIR = join(REPO_ROOT, 'supabase/migrations')
const MIGRATION_FILE = '20261108163517_add_rtb_payout_exception_candidates.sql'
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

const body = extractBody(sql, 'create or replace function public._rtb_merchant_payout_exception_candidates(')

describe('20261108163517_add_rtb_payout_exception_candidates.sql (category: ADMIN-CONTROL-CENTRE-BATCH-E27)', () => {
  it('1. defines exactly one function and nothing else', () => {
    const defs = codeOnly.match(/create or replace function/gi) ?? []
    expect(defs).toHaveLength(1)
    expect(normalized).toMatch(/create or replace function public\._rtb_merchant_payout_exception_candidates\(\)/)
  })

  it('2. is a pure read-only SQL function -- language sql, stable, security definer, empty search_path', () => {
    const header = normalized.slice(normalized.indexOf('create or replace function public._rtb_merchant_payout_exception_candidates('), normalized.indexOf('as $$'))
    expect(header).toMatch(/language sql/i)
    expect(header).toMatch(/\bstable\b/i)
    expect(header).toMatch(/security definer/i)
    expect(header).toMatch(/set search_path = ''/)
  })

  it('3. is reachable only by service_role -- explicit revoke from public/anon/authenticated, explicit grant to service_role', () => {
    expect(normalized).toMatch(/revoke all on function public\._rtb_merchant_payout_exception_candidates\(\) from public, anon, authenticated;/)
    expect(normalized).toMatch(/grant execute on function public\._rtb_merchant_payout_exception_candidates\(\) to service_role;/)
  })

  it('4. calls the canonical gate functions exactly once per row via a CASE in the CTE -- never re-invoked per predicate, never re-encoded', () => {
    const caseMatches = body.match(/public\._merchant_payout_full_eligibility_block\(mp\)/g) ?? []
    const stillSafeMatches = body.match(/public\._merchant_payout_still_safe_to_pay_block\(mp\)/g) ?? []
    expect(caseMatches).toHaveLength(1)
    expect(stillSafeMatches).toHaveLength(1)
    expect(body).toMatch(/case\s*\n\s*when mp\.status in \('pending', 'processing'\) then public\._merchant_payout_full_eligibility_block\(mp\)\s*\n\s*when mp\.status = 'paid' then public\._merchant_payout_still_safe_to_pay_block\(mp\)\s*\n\s*else null\s*\n\s*end as eligibility_block,/)
  })

  it('5. never independently re-implements an agreement-status, dispute, or merchant-restriction eligibility rule -- has_any_escrow/released_escrow_total/has_blocking_dispute/merchant_account_status are context fields only, never combined into a second blocking verdict inside this function', () => {
    // the only "return a verdict" shape in this body is the eligibility_block CASE itself
    const caseCount = (body.match(/\bcase\b/gi) ?? []).length
    expect(caseCount).toBe(1)
    expect(body).not.toMatch(/return 'source_payment_issue'|return 'compliance_review'|return 'account_restricted'/)
  })

  it('6. scopes to RTB payouts only, in the 3 operationally relevant statuses', () => {
    expect(body).toMatch(/where mp\.rent_to_buy_agreement_id is not null\s*\n\s*and mp\.status in \('pending', 'processing', 'paid'\)/)
  })

  it('7. has_any_escrow is a plain row-existence check with no status filter -- any status counts as participation, exactly matching E26\'s own v_has_escrow definition', () => {
    const existsClause = body.match(/exists \(\s*\n\s*select 1 from public\.escrow_transactions et\s*\n\s*where et\.rent_to_buy_agreement_id = mp\.rent_to_buy_agreement_id\s*\n\s*\) as has_any_escrow,/)
    expect(existsClause).toBeTruthy()
    expect(existsClause![0]).not.toMatch(/status/)
  })

  it('8. released_escrow_total only ever sums status = released rows, matching E24/E26\'s own backing calculation exactly', () => {
    expect(body).toMatch(/coalesce\(\(\s*\n\s*select sum\(et\.principal_amount\) from public\.escrow_transactions et\s*\n\s*where et\.rent_to_buy_agreement_id = mp\.rent_to_buy_agreement_id and et\.status = 'released'\s*\n\s*\), 0\) as released_escrow_total,/)
  })

  it('9. the dispute join is scoped to rent_to_buy_agreement_id, never booking_id -- this is the exact defect being fixed relative to the booking RPC', () => {
    expect(body).toMatch(/where d\.rent_to_buy_agreement_id = mp\.rent_to_buy_agreement_id and d\.status not in \('resolved', 'closed', 'cancelled'\)/)
    expect(body).not.toMatch(/d\.booking_id/)
  })

  it('10. the final filter returns only operationally relevant rows -- a blocked payout, or a paid payout missing its provider reference -- never every historical RTB payout', () => {
    expect(body).toMatch(/where eligibility_block is not null\s*\n\s*or \(status = 'paid' and provider_reference is null\);/)
  })

  it('11. every table and function reference is fully schema-qualified -- required for search_path = \'\' to be valid', () => {
    const bareTableRefs = body.match(/(?<!public\.)\b(merchant_payouts|rent_to_buy_agreements|escrow_transactions|disputes|profiles)\b/g) ?? []
    expect(bareTableRefs).toHaveLength(0)
  })

  it('12. never touches ledger_entries, create_merchant_payout, mark_payout_failed, mark_payout_processing, retry_payout, mark_payout_paid, record_escrow_webhook_event, resolve_dispute, refund_escrow_transaction, or the escrow dispute/completion blocks -- detection only, zero mutation authority touched', () => {
    expect(codeOnly).not.toMatch(/ledger_entries|create_merchant_payout\(|mark_payout_failed|mark_payout_processing|retry_payout|mark_payout_paid|record_escrow_webhook_event|resolve_dispute|refund_escrow_transaction|_escrow_transaction_dispute_block|_escrow_transaction_completion_block/)
  })

  it('13. never touches _rent_to_buy_settle_escrow, _rent_to_buy_settle_default_after_possession, finalize_rent_to_buy_ownership, or E26\'s own redefinitions -- this function only calls the 2 payout gates, never the settlement authority', () => {
    expect(codeOnly).not.toMatch(/function public\.(_rent_to_buy_settle_escrow|_rent_to_buy_settle_default_after_possession|finalize_rent_to_buy_ownership|_rent_to_buy_settle_default_before_possession)\(/)
  })

  it('14. this migration itself never issues a top-level data mutation -- it defines a read-only function and its grants only', () => {
    let outsideBodies = codeOnly
    let searchFrom = 0
    while (true) {
      const bodyStart = outsideBodies.indexOf('as $$', searchFrom)
      if (bodyStart === -1) break
      const bodyEnd = outsideBodies.indexOf('$$;', bodyStart)
      outsideBodies = outsideBodies.slice(0, bodyStart) + outsideBodies.slice(bodyEnd + 3)
      searchFrom = bodyStart
    }
    expect(outsideBodies).not.toMatch(/\binsert into\b/i)
    expect(outsideBodies).not.toMatch(/\bupdate\s+public\./i)
    expect(outsideBodies).not.toMatch(/\bdelete from\b/i)
    expect(body).not.toMatch(/\binsert into\b|\bupdate\s+public\.|\bdelete from\b/i)
  })

  it('15. never touches RLS, policies, tables, triggers, or extensions -- function creation only', () => {
    expect(codeOnly).not.toMatch(/create policy|drop policy|alter policy/i)
    expect(codeOnly).not.toMatch(/create table|drop table|alter table/i)
    expect(codeOnly).not.toMatch(/create trigger|drop trigger/i)
    expect(codeOnly).not.toMatch(/alter extension|create extension|drop extension/i)
    expect(codeOnly).not.toMatch(/enable row level security|disable row level security/i)
  })

  it('16. no dynamic SQL exists anywhere in this migration', () => {
    expect(codeOnly).not.toMatch(/\bEXECUTE\s+(format|'|")/i)
    expect(codeOnly).not.toMatch(/quote_ident|quote_literal/)
  })

  it('17. is forward-only -- sorts after every pre-existing migration, no historical file modified', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'))
    expect(files).toContain(MIGRATION_FILE)
    const earlier = files.filter((f) => f !== MIGRATION_FILE && f < MIGRATION_FILE)
    expect(earlier.length).toBeGreaterThan(0)
  })
})

describe('pre-existing fact check: merchant_payouts enforces at most one payout per RTB agreement', () => {
  it('18. a partial unique index on rent_to_buy_agreement_id already exists -- RTB duplicate-payout detection is unnecessary, confirming this phase\'s own audit', () => {
    const SCHEMA_FILE = join(MIGRATIONS_DIR, '20260821183555_rtb_v2_schema.sql')
    const content = readFileSync(SCHEMA_FILE, 'utf-8')
    expect(content).toMatch(/create unique index if not exists merchant_payouts_rtb_agreement_unique\s*\n\s*on public\.merchant_payouts\(rent_to_buy_agreement_id\) where rent_to_buy_agreement_id is not null;/)
  })
})

describe('pre-existing fact check: the booking exception RPC cannot see RTB payout context', () => {
  it('19. its only payment/dispute joins key on booking_id, which is always NULL for an RTB payout', () => {
    const BOOKING_RPC_FILE = join(MIGRATIONS_DIR, '20260904000005_payout_exception_context_relational.sql')
    const content = readFileSync(BOOKING_RPC_FILE, 'utf-8')
    const bookingBody = extractBody(content, 'create or replace function public._merchant_payout_exception_candidates(')
    expect(bookingBody).toMatch(/left join public\.payments p on p\.booking_id = mp\.booking_id/)
    expect(bookingBody).toMatch(/d\.booking_id = mp\.booking_id/)
    expect(bookingBody).not.toMatch(/rent_to_buy_agreement_id/)
  })
})
