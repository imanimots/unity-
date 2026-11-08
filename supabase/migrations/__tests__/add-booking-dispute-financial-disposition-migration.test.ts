import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

/**
 * E28 migration-contract test for
 * 20261108180657_add_booking_dispute_financial_disposition.sql.
 *
 * Scope: closes E23's own explicitly-deferred gap -- a booking dispute
 * resolved favor_raiser/mutual_agreement/manual_settlement restores
 * the booking to 'completed' with zero structured financial
 * consequence; create_refund() has no real application caller and no
 * provider-completion path anywhere in this codebase, and the payout
 * safety gates never query the `refunds` table at all. This migration
 * adds a narrow, 1:1 dispute_financial_disposition record, 2 RPCs to
 * create/complete it, a fail-closed extension to both booking payout
 * gates, and a matching visibility extension to the booking exception
 * RPC -- RTB/orders/barter are completely untouched.
 *
 * LIMITATION, per this codebase's established convention: this test
 * parses SQL source text and asserts on its structure. It does not
 * execute against a live Postgres instance.
 */
const REPO_ROOT = join(__dirname, '../../..')
const MIGRATIONS_DIR = join(REPO_ROOT, 'supabase/migrations')
const MIGRATION_FILE = '20261108180657_add_booking_dispute_financial_disposition.sql'
const MIGRATION_PATH = join(MIGRATIONS_DIR, MIGRATION_FILE)
const sql = readFileSync(MIGRATION_PATH, 'utf-8')
const codeOnly = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')
const normalized = codeOnly.replace(/\s+/g, ' ').trim()

const E26_FILE = join(MIGRATIONS_DIR, '20261108105222_restore_rtb_optional_escrow_compatibility.sql')
const e26Sql = readFileSync(E26_FILE, 'utf-8')
const BOOKING_RPC_FILE = join(MIGRATIONS_DIR, '20260904000005_payout_exception_context_relational.sql')
const bookingRpcSql = readFileSync(BOOKING_RPC_FILE, 'utf-8')

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

describe('20261108180657_add_booking_dispute_financial_disposition.sql (category: ADMIN-CONTROL-CENTRE-BATCH-E28)', () => {
  it('1. creates exactly one new table: dispute_financial_dispositions', () => {
    const creates = codeOnly.match(/create table/gi) ?? []
    expect(creates).toHaveLength(1)
    expect(normalized).toMatch(/create table if not exists public\.dispute_financial_dispositions \(/)
  })

  it('2. the table is 1:1 with disputes -- dispute_id is unique', () => {
    expect(normalized).toMatch(/dispute_id uuid not null unique references public\.disputes\(id\),/)
  })

  it('3. amount is required for refund_required/manual_financial_settlement and forbidden for no_financial_adjustment -- enforced by a CHECK constraint, not application code alone', () => {
    expect(normalized).toMatch(/constraint dispute_financial_dispositions_amount_chk check \( \(disposition_type = 'no_financial_adjustment' and amount is null\) or \(disposition_type in \('refund_required', 'manual_financial_settlement'\) and amount is not null\) \)/)
  })

  it('4. refund_id can only be set for the refund_required type', () => {
    expect(normalized).toMatch(/constraint dispute_financial_dispositions_refund_link_chk check \( refund_id is null or disposition_type = 'refund_required' \)/)
  })

  it('5. completed_at is set if and only if status = completed, and completed_by is required whenever completed_at is set', () => {
    expect(normalized).toMatch(/constraint dispute_financial_dispositions_completion_chk check \( \(status = 'completed'\) = \(completed_at is not null\) \)/)
    expect(normalized).toMatch(/constraint dispute_financial_dispositions_completed_by_chk check \( completed_at is null or completed_by is not null \)/)
  })

  it('6. reason is mandatory and non-empty -- an explicit no_financial_adjustment still requires intentional admin reasoning', () => {
    expect(normalized).toMatch(/reason text not null check \(length\(trim\(reason\)\) > 0\),/)
  })

  it('7. RLS is enabled with participant read + admin read only -- zero client write policies, mirroring dispute_history exactly', () => {
    expect(normalized).toMatch(/alter table public\.dispute_financial_dispositions enable row level security;/)
    const policies = codeOnly.match(/create policy/gi) ?? []
    expect(policies).toHaveLength(2)
    expect(normalized).toMatch(/create policy "dispute_financial_dispositions: parties read" on public\.dispute_financial_dispositions for select using \(public\.is_dispute_participant\(dispute_id, auth\.uid\(\)\)\);/)
    expect(normalized).toMatch(/create policy "dispute_financial_dispositions: admin read" on public\.dispute_financial_dispositions for select using \(exists \(select 1 from public\.profiles where profiles\.id = auth\.uid\(\) and profiles\.role = 'admin'\)\);/)
    // "for update" also appears legitimately as a SQL row-locking clause
    // (`... for update;`) inside the RPC bodies below -- each individual
    // `create policy ... ;` statement is extracted on its own and
    // checked in isolation, so a row-lock clause hundreds of lines later
    // can never be swept into this match.
    const policyStatements = codeOnly.match(/create policy[\s\S]*?;/gi) ?? []
    expect(policyStatements).toHaveLength(2)
    for (const stmt of policyStatements) {
      expect(stmt).not.toMatch(/\bfor (insert|update|delete)\b/i)
    }
  })

  it('8. the table is append-only -- deletion is blocked by prevent_row_mutation(), the same shared trigger every other immutable history table reuses', () => {
    expect(normalized).toMatch(/create trigger dispute_financial_dispositions_immutable\s*before delete on public\.dispute_financial_dispositions\s*for each row execute function public\.prevent_row_mutation\(\);/)
  })
})

describe('E28 -- record_dispute_financial_disposition: booking-scoped, explicit, fail-closed', () => {
  const body = extractBody(sql, 'create or replace function public.record_dispute_financial_disposition(')

  it('9. is service_role only, admin-id required, idempotency-keyed exactly like every other dispute RPC', () => {
    expect(body).toMatch(/if auth\.role\(\) <> 'service_role' then/)
    expect(body).toMatch(/if p_admin_id is null then/)
    expect(body).toMatch(/where merchant_id = p_admin_id and operation = 'record_dispute_financial_disposition' and idempotency_key = p_idempotency_key/)
  })

  it('10. rejects any disposition_type outside the 3 allowed values', () => {
    expect(body).toMatch(/if p_disposition_type not in \('no_financial_adjustment', 'refund_required', 'manual_financial_settlement'\) then/)
  })

  it('11. requires a non-empty reason unconditionally -- even for no_financial_adjustment', () => {
    expect(body).toMatch(/if p_reason is null or length\(trim\(p_reason\)\) = 0 then\s*\n\s*raise exception 'a reason is required';/)
  })

  it('12. rejects an amount on no_financial_adjustment, and requires a positive amount for the other two types -- in application logic, mirroring the table CHECK constraint, never contradicting it', () => {
    expect(body).toMatch(/if p_disposition_type = 'no_financial_adjustment' and p_amount is not null then/)
    expect(body).toMatch(/if p_disposition_type in \('refund_required', 'manual_financial_settlement'\) and \(p_amount is null or p_amount <= 0\) then/)
  })

  it('13. only operates on a booking dispute -- raises if the dispute has no booking_id, never silently widening to order/barter/RTB', () => {
    expect(body).toMatch(/if v_dispute\.booking_id is null then\s*\n\s*raise exception 'financial disposition is only supported for booking disputes';/)
  })

  it('14. requires the dispute to already be resolved or closed -- a disposition can never be recorded against an open/under-review dispute', () => {
    expect(body).toMatch(/if v_dispute\.status not in \('resolved', 'closed'\) then/)
  })

  it('15. enforces the 1:1 relationship explicitly, with a clear error, before ever attempting the insert (defense in depth alongside the table UNIQUE constraint)', () => {
    expect(body).toMatch(/if exists \(select 1 from public\.dispute_financial_dispositions where dispute_id = p_dispute_id\) then\s*\n\s*raise exception 'a financial disposition has already been recorded for this dispute';/)
  })

  it('16. for refund_required, locates the booking\'s rental_charge payment and fails closed if none exists or it is not refundable -- never guesses a payment to refund', () => {
    expect(body).toMatch(/where booking_id = v_dispute\.booking_id and payment_type = 'rental_charge'/)
    expect(body).toMatch(/if v_payment\.id is null then\s*\n\s*raise exception 'no rental charge payment exists for this booking to refund';/)
    expect(body).toMatch(/if v_payment\.status not in \('captured', 'partially_captured', 'partially_refunded'\) then/)
  })

  it('17. reuses create_refund() itself for refund_required -- never inserts into public.refunds directly, and never re-implements the cumulative refund cap', () => {
    expect(body).toMatch(/select \(public\.create_refund\(v_payment\.id, p_amount, p_reason, null\)->>'refund_id'\)::uuid into v_refund_id;/)
    const outsideCreateRefundCall = stripComments(body).replace(/select \(public\.create_refund\([^)]*\)->>'refund_id'\)::uuid into v_refund_id;/, '')
    expect(outsideCreateRefundCall).not.toMatch(/insert into public\.refunds/)
  })

  it('18. no_financial_adjustment is created already-completed; refund_required and manual_financial_settlement are created pending, requiring a separate completion step', () => {
    expect(body).toMatch(/if p_disposition_type = 'no_financial_adjustment' then\s*\n\s*v_status := 'completed';\s*\n\s*v_completed_by := p_admin_id;\s*\n\s*v_completed_at := now\(\);\s*\n\s*else\s*\n\s*v_status := 'pending';/)
  })

  it('19. writes an immutable dispute_history entry recording the disposition', () => {
    expect(body).toMatch(/insert into public\.dispute_history \(dispute_id, actor_user_id, actor_role, event_type, previous_status, new_status, metadata, idempotency_key\)/)
    expect(body).toMatch(/'financial_disposition_recorded'/)
  })

  it('20. preserves the exact grants -- service_role only', () => {
    expect(normalized).toMatch(/revoke all on function public\.record_dispute_financial_disposition\(uuid, uuid, text, numeric, text, text\) from public, anon, authenticated;/)
    expect(normalized).toMatch(/grant execute on function public\.record_dispute_financial_disposition\(uuid, uuid, text, numeric, text, text\) to service_role;/)
  })
})

describe('E28 -- complete_dispute_financial_disposition: explicit admin attestation only, never auto-executed', () => {
  const body = extractBody(sql, 'create or replace function public.complete_dispute_financial_disposition(')

  it('21. is service_role only, admin-id required, idempotency-keyed', () => {
    expect(body).toMatch(/if auth\.role\(\) <> 'service_role' then/)
    expect(body).toMatch(/if p_admin_id is null then/)
    expect(body).toMatch(/where merchant_id = p_admin_id and operation = 'complete_dispute_financial_disposition' and idempotency_key = p_idempotency_key/)
  })

  it('22. requires an existing disposition and rejects completing one that is not pending -- no silent no-op, no double-completion without idempotency protection', () => {
    expect(body).toMatch(/if v_disposition\.id is null then\s*\n\s*raise exception 'no financial disposition exists for this dispute';/)
    expect(body).toMatch(/if v_disposition\.status <> 'pending' then\s*\n\s*raise exception 'this financial disposition is not pending completion';/)
  })

  it('23. never calls a payment provider, never calls create_refund, never touches public.refunds, public.payments, or public.escrow_transactions -- it only records an admin attestation', () => {
    expect(body).not.toMatch(/create_refund|public\.refunds|public\.payments\b|public\.escrow_transactions/)
  })

  it('24. locks the disposition row FOR UPDATE before transitioning it, and sets completed_by/completed_at atomically with status', () => {
    expect(body).toMatch(/select \* into v_disposition from public\.dispute_financial_dispositions where dispute_id = p_dispute_id for update;/)
    expect(body).toMatch(/update public\.dispute_financial_dispositions\s*\n\s*set status = 'completed', completed_by = p_admin_id, completed_at = now\(\)/)
  })

  it('25. writes an immutable dispute_history entry recording the completion', () => {
    expect(body).toMatch(/'financial_disposition_completed'/)
  })

  it('26. preserves the exact grants -- service_role only', () => {
    expect(normalized).toMatch(/revoke all on function public\.complete_dispute_financial_disposition\(uuid, uuid, text, text\) from public, anon, authenticated;/)
    expect(normalized).toMatch(/grant execute on function public\.complete_dispute_financial_disposition\(uuid, uuid, text, text\) to service_role;/)
  })
})

describe('E28 -- payout fail-closed gate: booking branch only, RTB byte-for-byte unchanged', () => {
  it('27. _merchant_payout_full_eligibility_block\'s RTB branch is byte-for-byte unchanged from the current authoritative (E26) body', () => {
    const e26Body = extractBody(e26Sql, 'create or replace function public._merchant_payout_full_eligibility_block(')
    const e28Body = extractBody(sql, 'create or replace function public._merchant_payout_full_eligibility_block(')
    const e26Rtb = stripComments(e26Body.slice(0, e26Body.indexOf('if p_payout.booking_id is null')))
    const e28Rtb = stripComments(e28Body.slice(0, e28Body.indexOf('if p_payout.booking_id is null')))
    expect(e28Rtb).toBe(e26Rtb)
  })

  it('28. _merchant_payout_still_safe_to_pay_block\'s RTB branch is byte-for-byte unchanged from the current authoritative (E26) body', () => {
    const e26Body = extractBody(e26Sql, 'create or replace function public._merchant_payout_still_safe_to_pay_block(')
    const e28Body = extractBody(sql, 'create or replace function public._merchant_payout_still_safe_to_pay_block(')
    const rtbMarker = 'if p_payout.rent_to_buy_agreement_id is not null then'
    const e26Rtb = stripComments(e26Body.slice(e26Body.indexOf(rtbMarker), e26Body.indexOf('return null;\n  end if;\n\n  if exists (\n    select 1 from public.disputes\n    where booking_id')))
    const e28Rtb = stripComments(e28Body.slice(e28Body.indexOf(rtbMarker), e28Body.indexOf('return null;\n  end if;\n\n  if exists (\n    select 1 from public.disputes\n    where booking_id')))
    expect(e28Rtb).toBe(e26Rtb)
  })

  it('29. _merchant_payout_full_eligibility_block\'s booking branch, up to and including the E23 escrow-refund check, is byte-for-byte unchanged', () => {
    const e26Body = extractBody(e26Sql, 'create or replace function public._merchant_payout_full_eligibility_block(')
    const e28Body = extractBody(sql, 'create or replace function public._merchant_payout_full_eligibility_block(')
    const marker = 'if p_payout.booking_id is null'
    // The dispute-open check is the first thing that follows the escrow-refund
    // check in the OLD (E26) body, and the last thing that follows the NEW
    // E28 block in the NEW body -- using it as the end boundary in each
    // file's OWN text correctly captures "everything through the escrow-
    // refund check" in both, independent of what (if anything) was inserted
    // after it.
    const disputeOpenMarker = "if exists (\n    select 1 from public.disputes\n    where booking_id = p_payout.booking_id and status not in ('resolved', 'closed', 'cancelled')"
    const e26Slice = stripComments(e26Body.slice(e26Body.indexOf(marker), e26Body.indexOf(disputeOpenMarker)))
    const e28Slice = stripComments(e28Body.slice(e28Body.indexOf(marker), e28Body.indexOf('-- E28: a RESOLVED/CLOSED dispute')))
    expect(e28Slice).toBe(e26Slice)
  })

  it('30. _merchant_payout_full_eligibility_block adds the new financial_disposition_pending check, scoped to the booking branch, between the escrow-refund check and the dispute-open check', () => {
    const body = extractBody(sql, 'create or replace function public._merchant_payout_full_eligibility_block(')
    const bookingBranch = body.slice(body.indexOf('if p_payout.booking_id is null'))
    const escrowRefundIdx = bookingBranch.indexOf("select 1 from public.escrow_transactions\n    where booking_id = p_payout.booking_id and status in ('refunded', 'partially_refunded')")
    const dispositionIdx = bookingBranch.indexOf("return 'financial_disposition_pending';")
    const disputeOpenIdx = bookingBranch.indexOf("if exists (\n    select 1 from public.disputes\n    where booking_id = p_payout.booking_id and status not in ('resolved', 'closed', 'cancelled')")
    expect(escrowRefundIdx).toBeGreaterThan(-1)
    expect(dispositionIdx).toBeGreaterThan(escrowRefundIdx)
    expect(disputeOpenIdx).toBeGreaterThan(dispositionIdx)
    expect(bookingBranch).toMatch(/join public\.dispute_financial_dispositions dfd on dfd\.dispute_id = d\.id\s*\n\s*where d\.booking_id = p_payout\.booking_id\s*\n\s*and d\.status in \('resolved', 'closed'\)\s*\n\s*and dfd\.status = 'pending'/)
  })

  it('31. _merchant_payout_still_safe_to_pay_block adds the identical check to its booking branch', () => {
    const body = extractBody(sql, 'create or replace function public._merchant_payout_still_safe_to_pay_block(')
    expect(body).toMatch(/join public\.dispute_financial_dispositions dfd on dfd\.dispute_id = d\.id\s*\n\s*where d\.booking_id = p_payout\.booking_id\s*\n\s*and d\.status in \('resolved', 'closed'\)\s*\n\s*and dfd\.status = 'pending'/)
    const matches = body.match(/return 'financial_disposition_pending';/g) ?? []
    expect(matches).toHaveLength(1)
  })

  it('32. the new check never fires merely because a dispute is unresolved -- it explicitly requires status in (resolved, closed), the opposite condition of the existing open-dispute check', () => {
    for (const marker of ['create or replace function public._merchant_payout_full_eligibility_block(', 'create or replace function public._merchant_payout_still_safe_to_pay_block(']) {
      const body = extractBody(sql, marker)
      const check = body.match(/if exists \(\s*\n\s*select 1 from public\.disputes d\s*\n\s*join public\.dispute_financial_dispositions dfd[\s\S]*?end if;/)?.[0] ?? ''
      expect(check).toMatch(/d\.status in \('resolved', 'closed'\)/)
      expect(check).not.toMatch(/not in/)
    }
  })

  it('33. preserves the exact prior grants for both gate functions -- service_role only, no widening', () => {
    for (const name of ['_merchant_payout_full_eligibility_block', '_merchant_payout_still_safe_to_pay_block']) {
      expect(normalized).toMatch(new RegExp(`revoke all on function public\\.${name}\\(public\\.merchant_payouts\\) from public, anon, authenticated;`))
      expect(normalized).toMatch(new RegExp(`grant execute on function public\\.${name}\\(public\\.merchant_payouts\\) to service_role;`))
    }
  })
})

describe('E28 -- booking exception-candidate RPC: widened for visibility, DROP + CREATE (return shape changed)', () => {
  it('34. drops before creating -- required because RETURNS TABLE gained a new column', () => {
    const dropIdx = codeOnly.indexOf('drop function if exists public._merchant_payout_exception_candidates();')
    const createIdx = codeOnly.indexOf('create function public._merchant_payout_exception_candidates()')
    expect(dropIdx).toBeGreaterThan(-1)
    expect(createIdx).toBeGreaterThan(dropIdx)
  })

  it('35. every pre-existing field, join, and predicate is reproduced byte-for-byte from the original (20260904000005) body, with only the one new field/predicate added', () => {
    const originalBody = stripComments(extractBody(bookingRpcSql, 'create or replace function public._merchant_payout_exception_candidates('))
    const newBody = stripComments(extractBody(sql, 'create function public._merchant_payout_exception_candidates('))
    for (const line of originalBody.split('\n').map((l) => l.trim()).filter(Boolean)) {
      expect(newBody, `missing original line: ${line}`).toContain(line)
    }
  })

  it('36. the new has_pending_financial_disposition field uses the identical join shape as the payout gates\' own check -- never a second, divergent definition', () => {
    const body = extractBody(sql, 'create function public._merchant_payout_exception_candidates(')
    expect(body).toMatch(/exists \(\s*\n\s*select 1 from public\.disputes d\s*\n\s*join public\.dispute_financial_dispositions dfd on dfd\.dispute_id = d\.id\s*\n\s*where d\.booking_id = mp\.booking_id and d\.status in \('resolved', 'closed'\) and dfd\.status = 'pending'\s*\n\s*\) as has_pending_financial_disposition/)
  })

  it('37. the predicate includes has_pending_financial_disposition for both the unpaid and paid branches', () => {
    const body = extractBody(sql, 'create function public._merchant_payout_exception_candidates(')
    const matches = body.match(/or has_pending_financial_disposition/g) ?? []
    expect(matches).toHaveLength(2)
  })

  it('38. preserves the exact grants -- service_role only', () => {
    expect(normalized).toMatch(/revoke all on function public\._merchant_payout_exception_candidates\(\) from public, anon, authenticated;/)
    expect(normalized).toMatch(/grant execute on function public\._merchant_payout_exception_candidates\(\) to service_role;/)
  })
})

describe('E28 -- scope and safety contract', () => {
  it('39. never touches resolve_dispute, open_dispute, cancel_dispute, close_dispute, or the RTB-specific restore logic', () => {
    expect(codeOnly).not.toMatch(/function public\.(resolve_dispute|open_dispute|cancel_dispute|close_dispute|start_dispute_review|assign_dispute_to_admin|request_dispute_evidence)\(/)
  })

  it('40. never touches orders, barter_agreements, or rent_to_buy_agreements tables/columns -- booking-only scope', () => {
    expect(codeOnly).not.toMatch(/alter table public\.(orders|barter_agreements|rent_to_buy_agreements)\b/)
  })

  it('41. never touches ledger_entries, prevent_row_mutation\'s own definition, or any escrow refund/release RPC -- E18/E25 untouched', () => {
    expect(codeOnly).not.toMatch(/alter table public\.ledger_entries|create or replace function public\.prevent_row_mutation|function public\.(refund_escrow_transaction|release_escrow_transaction|cancel_escrow_transaction)\(/)
  })

  it('42. never mutates create_refund itself -- only calls it, exactly as already defined', () => {
    expect(codeOnly).not.toMatch(/create or replace function public\.create_refund/)
  })

  it('43. this migration itself never issues a top-level data mutation outside a function body or the fixed table/policy/trigger DDL it defines', () => {
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
    expect(outsideBodies).not.toMatch(/\bupdate\s+public\.(?!merchant_payouts|bookings)/i)
    expect(outsideBodies).not.toMatch(/\bdelete from\b/i)
  })

  it('44. no dynamic SQL exists anywhere in this migration', () => {
    expect(codeOnly).not.toMatch(/\bEXECUTE\s+(format|'|")/i)
    expect(codeOnly).not.toMatch(/quote_ident|quote_literal/)
  })

  it('45. is forward-only -- sorts after every pre-existing migration, no historical file modified', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'))
    expect(files).toContain(MIGRATION_FILE)
    const earlier = files.filter((f) => f !== MIGRATION_FILE && f < MIGRATION_FILE)
    expect(earlier.length).toBeGreaterThan(0)
  })
})

describe('pre-existing fact check: the historical non-respondent booking dispute set is never touched', () => {
  it('46. no UPDATE/DELETE targets disputes, merchant_payouts, payments, or refunds rows outside the 2 new RPCs\' own narrow, idempotency-gated writes', () => {
    // Every UPDATE in this file is one of: disputes (none -- resolve_dispute
    // itself is untouched), merchant_payouts (none), payments (none --
    // only read FOR UPDATE inside record_dispute_financial_disposition, to
    // lock before calling create_refund()), or the new
    // dispute_financial_dispositions table itself (its own completion
    // transition). No backfill, no bulk update, no historical row touched.
    expect(codeOnly).not.toMatch(/update public\.disputes\b/)
    expect(codeOnly).not.toMatch(/update public\.merchant_payouts\b/)
    expect(codeOnly).not.toMatch(/update public\.payments\b/)
    expect(codeOnly).not.toMatch(/update public\.refunds\b/)
  })
})

describe('pre-existing fact check: create_refund has zero real application callers and no provider-completion path', () => {
  it('47. the only reference to create_refund outside migrations/docs is a regression script, never a real API route, service, or orchestrator', () => {
    const srcFiles: string[] = []
    function walk(dir: string) {
      for (const entry of readdirSync(join(REPO_ROOT, dir), { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
        const rel = join(dir, entry.name)
        if (entry.isDirectory()) walk(rel)
        else if (/\.(ts|tsx|mjs)$/.test(entry.name)) srcFiles.push(rel)
      }
    }
    walk('src')
    walk('scripts')
    const realCallers = srcFiles.filter((f) => {
      const content = readFileSync(join(REPO_ROOT, f), 'utf-8')
      return /rpc\(\s*['"]create_refund['"]/.test(content)
    })
    expect(realCallers).toEqual(['scripts/verify-commissions-phase2.mjs'])
  })

  it('48. the payments webhook route explicitly defers refund-type provider events rather than completing them', () => {
    const content = readFileSync(join(REPO_ROOT, 'src/app/api/payments/webhooks/[provider]/route.ts'), 'utf-8')
    expect(content).toMatch(/refund_event_reconciliation_not_yet_implemented/)
  })
})
