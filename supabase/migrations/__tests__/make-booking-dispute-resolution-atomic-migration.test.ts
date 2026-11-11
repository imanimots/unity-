import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

/**
 * E28-R1 migration-contract test for
 * 20261111105618_make_booking_dispute_resolution_atomic.sql.
 *
 * Scope: E28's resolve route made two separate RPC calls
 * (resolve_dispute, then record_dispute_financial_disposition)
 * across a network round trip -- if the first succeeded and the
 * second failed, the durable result was a resolved, restored booking
 * with no disposition row, reopening a smaller-window version of the
 * exact race E28 closed. This migration adds one new, booking-only,
 * atomic RPC (resolve_booking_dispute) that performs every write in
 * the same PL/pgSQL function body -- which has no transaction
 * boundary of its own and no exception handler, so an unhandled
 * RAISE EXCEPTION anywhere in it rolls back every write the call made,
 * with no durable intermediate state possible. resolve_dispute()
 * gains exactly one new guard rejecting booking disputes outright
 * (forcing them through the new RPC), and
 * record_dispute_financial_disposition() (E28) is dropped, since it
 * has zero callers left and was itself a residual bypass path.
 *
 * LIMITATION, per this codebase's established convention: this test
 * parses SQL source text and asserts on its structure. It does not
 * execute against a live Postgres instance. The atomicity claim
 * itself rests on a standard, well-documented PL/pgSQL guarantee
 * (an unhandled exception in a function body aborts the calling
 * transaction), which this test verifies the PRECONDITION for --
 * the complete absence of any EXCEPTION handler in the new function
 * -- rather than re-deriving the guarantee itself.
 */
const REPO_ROOT = join(__dirname, '../../..')
const MIGRATIONS_DIR = join(REPO_ROOT, 'supabase/migrations')
const MIGRATION_FILE = '20261111105618_make_booking_dispute_resolution_atomic.sql'
const MIGRATION_PATH = join(MIGRATIONS_DIR, MIGRATION_FILE)
const sql = readFileSync(MIGRATION_PATH, 'utf-8')
const codeOnly = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')
const normalized = codeOnly.replace(/\s+/g, ' ').trim()

const E28_FILE = join(MIGRATIONS_DIR, '20261108180657_add_booking_dispute_financial_disposition.sql')
const e28Sql = readFileSync(E28_FILE, 'utf-8')
const DISPUTE_RESOLVE_FILE = join(MIGRATIONS_DIR, '20260904000003_dispute_resolve_restore_booking_all_outcomes.sql')
const disputeResolveSql = readFileSync(DISPUTE_RESOLVE_FILE, 'utf-8')

function extractBody(src: string, marker: string): string {
  const idx = src.indexOf(marker)
  if (idx === -1) throw new Error(`marker not found: ${marker}`)
  const start = src.indexOf('as $$', idx)
  const end = src.indexOf('$$;', start)
  return src.slice(start + 5, end).trim()
}

function stripComments(body: string): string {
  return body.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
}

describe('20261111105618_make_booking_dispute_resolution_atomic.sql (category: ADMIN-CONTROL-CENTRE-BATCH-E28-R1)', () => {
  it('1. redefines resolve_dispute, defines resolve_booking_dispute, and drops record_dispute_financial_disposition -- nothing else', () => {
    const creates = codeOnly.match(/create or replace function/gi) ?? []
    expect(creates).toHaveLength(2)
    expect(normalized).toMatch(/create or replace function public\.resolve_dispute\(/)
    expect(normalized).toMatch(/create or replace function public\.resolve_booking_dispute\(/)
    expect(normalized).toMatch(/drop function if exists public\.record_dispute_financial_disposition\(uuid, uuid, text, numeric, text, text\);/)
  })
})

describe('E28-R1 -- resolve_dispute: exactly one new guard, everything else byte-for-byte unchanged', () => {
  const body = extractBody(sql, 'create or replace function public.resolve_dispute(')
  const oldBody = extractBody(disputeResolveSql, 'create or replace function public.resolve_dispute(')

  it('2. adds a guard rejecting a booking dispute, immediately after the not-found check', () => {
    expect(body).toMatch(/if v_dispute\.id is null then\s*\n\s*raise exception 'dispute not found';\s*\n\s*end if;\s*\n\s*\n?\s*(--[^\n]*\n\s*)*if v_dispute\.booking_id is not null then\s*\n\s*raise exception 'booking disputes must be resolved via resolve_booking_dispute';\s*\n\s*end if;/)
  })

  it('3. removing exactly that new guard reproduces the old (20260904000003) body, modulo whitespace', () => {
    const guardPattern = /\s*-- E28-R1:[\s\S]*?if v_dispute\.booking_id is not null then\s*\n\s*raise exception 'booking disputes must be resolved via resolve_booking_dispute';\s*\n\s*end if;\n/
    const normalizeWhitespace = (s: string) => s.replace(/\s+/g, ' ').trim()
    const withGuardRemoved = normalizeWhitespace(stripComments(body.replace(guardPattern, '\n')))
    expect(withGuardRemoved).toBe(normalizeWhitespace(stripComments(oldBody)))
  })

  it('4. preserves SECURITY DEFINER, search_path = public, and the comment documenting that CREATE OR REPLACE keeps the existing grants', () => {
    const header = normalized.slice(normalized.indexOf('create or replace function public.resolve_dispute('), normalized.indexOf('as $$'))
    expect(header).toMatch(/security definer/i)
    expect(header).toMatch(/set search_path = public/i)
    expect(sql).toMatch(/-- CREATE OR REPLACE preserves the existing grants \(service_role only\)\./)
  })
})

describe('E28-R1 -- resolve_booking_dispute: the new atomic authority', () => {
  const body = extractBody(sql, 'create or replace function public.resolve_booking_dispute(')

  it('5. is service_role only, admin-id required, outcome-validated, disposition-type-validated, reason required', () => {
    expect(body).toMatch(/if auth\.role\(\) <> 'service_role' then/)
    expect(body).toMatch(/if p_admin_id is null then/)
    expect(body).toMatch(/if p_outcome not in \('favor_raiser', 'favor_respondent', 'mutual_agreement', 'manual_settlement'\) then/)
    expect(body).toMatch(/if p_disposition_type not in \('no_financial_adjustment', 'refund_required', 'manual_financial_settlement'\) then/)
    expect(body).toMatch(/if p_disposition_reason is null or length\(trim\(p_disposition_reason\)\) = 0 then/)
  })

  it('6. rejects an amount on no_financial_adjustment, and requires a positive amount for the other two types', () => {
    expect(body).toMatch(/if p_disposition_type = 'no_financial_adjustment' and p_disposition_amount is not null then/)
    expect(body).toMatch(/if p_disposition_type in \('refund_required', 'manual_financial_settlement'\) and \(p_disposition_amount is null or p_disposition_amount <= 0\) then/)
  })

  it('7. only operates on a booking dispute, requires it to be under_review, and enforces the 1:1 disposition relationship explicitly', () => {
    expect(body).toMatch(/if v_dispute\.booking_id is null then\s*\n\s*raise exception 'resolve_booking_dispute is only for booking disputes';/)
    expect(body).toMatch(/if v_dispute\.status <> 'under_review' then/)
    expect(body).toMatch(/if exists \(select 1 from public\.dispute_financial_dispositions where dispute_id = p_dispute_id\) then\s*\n\s*raise exception 'a financial disposition has already been recorded for this dispute';/)
  })

  it('8. fails closed on refund_required when the booking has any escrow activity -- checked before the refund payment lookup, in any status, not just funded', () => {
    const refundBranch = body.slice(body.indexOf("if p_disposition_type = 'refund_required' then"), body.indexOf('if p_disposition_type = \'no_financial_adjustment\' then'))
    const escrowCheckIdx = refundBranch.indexOf('select 1 from public.escrow_transactions where booking_id = v_dispute.booking_id')
    const paymentLookupIdx = refundBranch.indexOf("from public.payments\n    where booking_id = v_dispute.booking_id and payment_type = 'rental_charge'")
    expect(escrowCheckIdx).toBeGreaterThan(-1)
    expect(paymentLookupIdx).toBeGreaterThan(escrowCheckIdx)
    expect(refundBranch).not.toMatch(/escrow_transactions where booking_id = v_dispute\.booking_id and status/)
  })

  it('9. reuses create_refund() itself -- never inserts into public.refunds directly, and never re-implements the cumulative refund cap', () => {
    expect(body).toMatch(/select \(public\.create_refund\(v_payment\.id, p_disposition_amount, p_disposition_reason, null\)->>'refund_id'\)::uuid into v_refund_id;/)
    const outsideCreateRefundCall = stripComments(body).replace(/select \(public\.create_refund\([^)]*\)->>'refund_id'\)::uuid into v_refund_id;/, '')
    expect(outsideCreateRefundCall).not.toMatch(/insert into public\.refunds/)
  })

  it('10. no_financial_adjustment is created already-completed; the other two are created pending', () => {
    expect(body).toMatch(/if p_disposition_type = 'no_financial_adjustment' then\s*\n\s*v_disposition_status := 'completed';\s*\n\s*v_completed_by := p_admin_id;\s*\n\s*v_completed_at := now\(\);\s*\n\s*else\s*\n\s*v_disposition_status := 'pending';/)
  })

  it('11. writes the disposition insert, the dispute resolution update, both history rows, and the booking restoration all in this one function body', () => {
    expect(body).toMatch(/insert into public\.dispute_financial_dispositions/)
    expect(body).toMatch(/update public\.disputes set\s*\n\s*status = 'resolved',/)
    expect(body).toMatch(/'dispute_resolved'/)
    expect(body).toMatch(/'financial_disposition_recorded'/)
    expect(body).toMatch(/update public\.bookings\s*\n\s*set status = v_dispute\.pre_dispute_status::booking_status, version = version \+ 1/)
    expect(body).toMatch(/insert into public\.booking_history/)
  })

  it('12. contains no BEGIN/EXCEPTION/END exception-handling block anywhere -- the precondition for the atomicity claim: an unhandled exception at any point rolls back every write this function already made', () => {
    expect(body).not.toMatch(/exception\s+when/i)
  })

  it('13. idempotency request hash includes every financially material input -- dispute id, outcome, resolution notes, disposition type, amount, and reason', () => {
    expect(body).toMatch(/v_request_hash := md5\(\s*\n\s*coalesce\(p_dispute_id::text, ''\) \|\| '\|' \|\| coalesce\(p_outcome, ''\) \|\| '\|' \|\| coalesce\(p_resolution_notes, ''\) \|\| '\|' \|\|\s*\n\s*coalesce\(p_disposition_type, ''\) \|\| '\|' \|\| coalesce\(p_disposition_amount::text, ''\) \|\| '\|' \|\| coalesce\(p_disposition_reason, ''\)\s*\n\s*\);/)
  })

  it('14. a replayed idempotency key with a different request hash is rejected, exactly like every other dispute RPC', () => {
    expect(body).toMatch(/if v_idem\.request_hash is distinct from v_request_hash then\s*\n\s*raise exception 'idempotency key already used with a different request';/)
  })

  it('15. does not accept a payment_id parameter -- the booking\'s own rental_charge payment is derived internally, narrower surface than the brief\'s own suggested shape', () => {
    const header = normalized.slice(normalized.indexOf('create or replace function public.resolve_booking_dispute('), normalized.indexOf('as $$'))
    expect(header).not.toMatch(/p_payment_id/)
  })

  it('16. preserves the exact grants -- service_role only', () => {
    expect(normalized).toMatch(/revoke all on function public\.resolve_booking_dispute\(uuid, uuid, text, text, text, numeric, text, text\) from public, anon, authenticated;/)
    expect(normalized).toMatch(/grant execute on function public\.resolve_booking_dispute\(uuid, uuid, text, text, text, numeric, text, text\) to service_role;/)
  })

  it('17. uses search_path = public, matching resolve_dispute\'s own convention, documented as deliberate in this migration\'s header', () => {
    const markerIdx = normalized.indexOf('create or replace function public.resolve_booking_dispute(')
    const header = normalized.slice(markerIdx, normalized.indexOf('as $$', markerIdx))
    expect(header).toMatch(/set search_path = public/i)
    expect(sql).toMatch(/search_path = public \(not ''\)/)
  })
})

describe('E28-R1 -- record_dispute_financial_disposition is dropped, not merely left uncalled', () => {
  it('18. the drop statement targets the exact signature E28 defined it with', () => {
    const e28Header = e28Sql.slice(
      e28Sql.indexOf('create or replace function public.record_dispute_financial_disposition('),
      e28Sql.indexOf('as $$', e28Sql.indexOf('create or replace function public.record_dispute_financial_disposition('))
    )
    expect(e28Header).toMatch(/p_admin_id uuid,\s*\n\s*p_dispute_id uuid,\s*\n\s*p_disposition_type text,\s*\n\s*p_amount numeric default null,\s*\n\s*p_reason text default null,\s*\n\s*p_idempotency_key text default null/)
    expect(normalized).toMatch(/drop function if exists public\.record_dispute_financial_disposition\(uuid, uuid, text, numeric, text, text\);/)
  })

  it('19. this migration never redefines record_dispute_financial_disposition -- drop only, no resurrection', () => {
    expect(codeOnly).not.toMatch(/create (or replace )?function public\.record_dispute_financial_disposition/)
  })
})

describe('E28-R1 -- scope and safety contract', () => {
  it('20. never touches complete_dispute_financial_disposition, create_refund itself, the booking payout gates, or the booking/RTB exception RPCs -- those remain E28/E27\'s own unchanged authority', () => {
    expect(codeOnly).not.toMatch(/function public\.(complete_dispute_financial_disposition|create_refund|_merchant_payout_full_eligibility_block|_merchant_payout_still_safe_to_pay_block|_merchant_payout_exception_candidates|_rtb_merchant_payout_exception_candidates)\(/)
  })

  it('21. never touches open_dispute, cancel_dispute, close_dispute, start_dispute_review, assign_dispute_to_admin, request_dispute_evidence, or any RTB settlement function', () => {
    expect(codeOnly).not.toMatch(/function public\.(open_dispute|cancel_dispute|close_dispute|start_dispute_review|assign_dispute_to_admin|request_dispute_evidence|_rent_to_buy_settle_escrow|_rent_to_buy_settle_default_after_possession|finalize_rent_to_buy_ownership)\(/)
  })

  it('22. never touches ledger_entries, refund_escrow_transaction, release_escrow_transaction, or dispute_financial_dispositions\' own table definition/RLS', () => {
    expect(codeOnly).not.toMatch(/ledger_entries|function public\.(refund_escrow_transaction|release_escrow_transaction)\(/)
    expect(codeOnly).not.toMatch(/create table|alter table|create policy|enable row level security/i)
  })

  it('23. this migration itself never issues a top-level data mutation outside a function body', () => {
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
  })

  it('24. no dynamic SQL exists anywhere in this migration', () => {
    expect(codeOnly).not.toMatch(/\bEXECUTE\s+(format|'|")/i)
    expect(codeOnly).not.toMatch(/quote_ident|quote_literal/)
  })

  it('25. is forward-only -- sorts after every pre-existing migration, including E28 itself, no historical file modified', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'))
    expect(files).toContain(MIGRATION_FILE)
    const earlier = files.filter((f) => f !== MIGRATION_FILE && f < MIGRATION_FILE)
    expect(earlier.length).toBeGreaterThan(0)
    expect(MIGRATION_FILE > '20261108180657_add_booking_dispute_financial_disposition.sql').toBe(true)
  })
})

describe('pre-existing fact check: the historical non-respondent booking dispute set remains untouched by this migration', () => {
  it('26. no UPDATE/DELETE targets disputes, bookings, merchant_payouts, payments, refunds, or escrow_transactions rows outside resolve_booking_dispute\'s own narrow, idempotency-gated writes', () => {
    expect(codeOnly).not.toMatch(/update public\.merchant_payouts\b/)
    expect(codeOnly).not.toMatch(/update public\.payments\b/)
    expect(codeOnly).not.toMatch(/update public\.refunds\b/)
    expect(codeOnly).not.toMatch(/update public\.escrow_transactions\b/)
  })
})

describe('pre-existing fact check: the app no longer makes a two-RPC booking resolution call', () => {
  it('27. the admin resolve route calls resolve_booking_dispute for a booking dispute, never record_dispute_financial_disposition', () => {
    const routeContent = readFileSync(join(REPO_ROOT, 'src/app/api/admin/disputes/[id]/resolve/route.ts'), 'utf-8')
    expect(routeContent).toMatch(/rpc\(\s*['"]resolve_booking_dispute['"]/)
    expect(routeContent).not.toMatch(/record_dispute_financial_disposition/)
  })
})
