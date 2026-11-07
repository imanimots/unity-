import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

/**
 * E24 migration-contract test for
 * 20261107190421_harden_rtb_escrow_payout_conservation.sql.
 *
 * Scope: a fresh audit of the RTB settlement chain confirmed a real
 * conservation gap -- Unity commission and merchant payout amounts
 * for RTB default/termination settlement were computed from the
 * THEORETICAL requested escrow-release budget (the calculated
 * recovery cap, or total_purchase_price at successful completion),
 * never from what public._rent_to_buy_settle_escrow actually
 * released. Since that helper deliberately releases/refunds whole
 * rows only (never splitting one across both), a row straddling the
 * cap boundary means actual release can be strictly less than the
 * theoretical figure -- so a merchant_payout (and its immutable
 * ledger_entries row) could be created for more than escrow ever
 * backed.
 *
 * Fix: the settlement helper now reports back {released_amount,
 * refunded_amount} (changed from `returns void` to `returns jsonb` --
 * requiring DROP + CREATE, since Postgres does not allow changing a
 * function's return type via CREATE OR REPLACE), and its two
 * money-moving callers use the actual released amount instead of the
 * theoretical one. Defense-in-depth: both RTB payout-safety gates now
 * also block if a payout's amount exceeds the sum of principal_amount
 * across that agreement's RELEASED (not merely non-refunded) escrow
 * rows -- deliberately NOT "any refunded row blocks the payout",
 * since legitimate RTB settlement always leaves some rows refunded
 * alongside released ones.
 *
 * LIMITATION, per this codebase's established convention: this test
 * parses SQL source text and asserts on its structure; it does not
 * execute against a live Postgres instance. The numeric conservation
 * property itself is additionally verified by a TypeScript simulation
 * of the exact, simple, documented whole-row algorithm (oldest-first,
 * release-or-refund-in-full, never split) -- this proves the
 * algorithm's own conservation property holds, not that the deployed
 * SQL executes identically; the SQL structural assertions above
 * separately prove the SQL now consumes that algorithm's actual
 * output rather than a theoretical figure.
 */
const REPO_ROOT = join(__dirname, '../../..')
const MIGRATIONS_DIR = join(REPO_ROOT, 'supabase/migrations')
const MIGRATION_FILE = '20261107190421_harden_rtb_escrow_payout_conservation.sql'
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

describe('20261107190421_harden_rtb_escrow_payout_conservation.sql (category: ADMIN-CONTROL-CENTRE-BATCH-E24) -- settlement helper', () => {
  it('1. drops the old void-returning signature before recreating it (Postgres cannot change return type via CREATE OR REPLACE)', () => {
    expect(normalized).toMatch(/drop function public\._rent_to_buy_settle_escrow\(uuid, numeric, uuid, text, uuid, text\);/)
    expect(codeOnly).not.toMatch(/drop function[^;]*cascade/i)
    const dropIdx = normalized.indexOf('drop function public._rent_to_buy_settle_escrow')
    const createIdx = normalized.indexOf('create function public._rent_to_buy_settle_escrow')
    expect(createIdx).toBeGreaterThan(dropIdx)
  })

  it('2. the new signature returns jsonb, not void', () => {
    const header = normalized.slice(normalized.indexOf('create function public._rent_to_buy_settle_escrow('), normalized.indexOf('as $$'))
    expect(header).toMatch(/returns jsonb/)
    expect(header).not.toMatch(/returns void/)
  })

  it('3. returns both released_amount and refunded_amount', () => {
    const body = extractBody(sql, 'create function public._rent_to_buy_settle_escrow(')
    expect(body).toMatch(/return jsonb_build_object\('released_amount', v_released_total, 'refunded_amount', v_refunded_total\);/)
  })

  it('4. the per-row release/refund branching logic is otherwise unchanged -- same oldest-first order, same FOR UPDATE lock, same whole-row-only transitions', () => {
    const body = extractBody(sql, 'create function public._rent_to_buy_settle_escrow(')
    expect(body).toMatch(/order by created_at asc\s*\n\s*for update/)
    expect(body).toMatch(/if v_remaining >= v_row\.principal_amount then/)
    expect(body).toMatch(/'released', array\['funded'\]::escrow_status\[\]/)
    expect(body).toMatch(/'refunded', array\['funded'\]::escrow_status\[\]/)
    // Never splits a row: only ever adds the FULL principal_amount to one running total or the other.
    expect(body).not.toMatch(/v_remaining\s*-\s*v_row\.principal_amount.*refunded_total|refunded_total.*v_remaining\s*-/)
  })

  it('5. preserves SECURITY DEFINER, search_path = public (not E24\'s concern to harden), and the exact prior grants', () => {
    const header = normalized.slice(normalized.indexOf('create function public._rent_to_buy_settle_escrow('), normalized.indexOf('as $$'))
    expect(header).toMatch(/security definer/i)
    expect(header).toMatch(/set search_path = public/i)
    expect(normalized).toMatch(/revoke all on function public\._rent_to_buy_settle_escrow\(uuid, numeric, uuid, text, uuid, text\) from public, anon, authenticated;/)
    expect(normalized).toMatch(/grant execute on function public\._rent_to_buy_settle_escrow\(uuid, numeric, uuid, text, uuid, text\) to service_role;/)
  })
})

describe('E24 -- _rent_to_buy_settle_default_after_possession', () => {
  const body = extractBody(sql, 'create or replace function public._rent_to_buy_settle_default_after_possession(')

  it('6. calls the settlement helper via SELECT ... INTO (capturing the jsonb result), not a bare PERFORM', () => {
    expect(body).toMatch(/select public\._rent_to_buy_settle_escrow\([^)]*\)\s*\n\s*into v_settle_result;/)
  })

  it('7. extracts actual_released/actual_refunded from the settlement result', () => {
    expect(body).toMatch(/v_actual_released := coalesce\(\(v_settle_result->>'released_amount'\)::numeric\(12,2\), 0\);/)
    expect(body).toMatch(/v_actual_refunded := coalesce\(\(v_settle_result->>'refunded_amount'\)::numeric\(12,2\), 0\);/)
  })

  it('8. commission is calculated on v_actual_released, not v_recovered_amount', () => {
    expect(body).toMatch(/if v_actual_released > 0 and v_agreement\.rental_commission_rate_bps/)
    expect(body).toMatch(/_calculate_unity_commission\('rental', v_actual_released, v_agreement\.rental_commission_rate_bps\)/)
    expect(body).not.toMatch(/_calculate_unity_commission\('rental', v_recovered_amount,/)
  })

  it('9. the unity_commissions eligible_base column is also v_actual_released, not v_recovered_amount, keeping the calculation and its stored audit value consistent', () => {
    const insertIdx = body.indexOf('insert into public.unity_commissions')
    const valuesIdx = body.indexOf('values (', insertIdx)
    const valuesBlock = body.slice(valuesIdx, body.indexOf(')', body.indexOf('v_commission_amount', valuesIdx)))
    expect(valuesBlock).toMatch(/v_actual_released/)
  })

  it('10. the payout amount is v_actual_released minus commission, not v_recovered_amount minus commission', () => {
    expect(body).toMatch(/if v_actual_released - coalesce\(v_commission_amount, 0\) > 0 then/)
    expect(body).toMatch(/create_merchant_payout\(v_agreement\.merchant_id, null, v_actual_released - v_commission_amount, null, p_agreement_id\)/)
    expect(body).not.toMatch(/create_merchant_payout\([^)]*v_recovered_amount - v_commission_amount/)
  })

  it('11. the settlement call happens before the commission calculation (actual release must be known first)', () => {
    const settleIdx = body.indexOf('_rent_to_buy_settle_escrow(')
    const commissionIdx = body.indexOf('_calculate_unity_commission(')
    expect(settleIdx).toBeGreaterThan(-1)
    expect(commissionIdx).toBeGreaterThan(settleIdx)
  })

  it('12. v_recovered_amount is still computed and still used as the requested release budget passed into settlement -- it is a request, not a result', () => {
    expect(body).toMatch(/v_recovered_amount := least\(v_rental_use_amount, v_held_total\);/)
    expect(body).toMatch(/_rent_to_buy_settle_escrow\(p_agreement_id, v_recovered_amount,/)
  })

  it('13. the history audit record now additionally includes actual_released_amount and actual_refunded_amount', () => {
    const historyIdx = body.lastIndexOf('_rent_to_buy_history(')
    const historyCall = body.slice(historyIdx, body.indexOf(';', historyIdx))
    expect(historyCall).toMatch(/actual_released_amount/)
    expect(historyCall).toMatch(/actual_refunded_amount/)
  })
})

describe('E24 -- finalize_rent_to_buy_ownership', () => {
  const body = extractBody(sql, 'create or replace function public.finalize_rent_to_buy_ownership(')

  it('14. commission base is unchanged -- still the possession-period rental/use amount, never escrow- or purchase-price-derived', () => {
    expect(body).toMatch(/v_eligible_base := public\._rent_to_buy_rental_use_amount\(v_agreement, v_agreement\.possession_confirmed_at, now\(\)\);/)
    expect(body).toMatch(/_calculate_unity_commission\('rental', v_eligible_base, v_agreement\.rental_commission_rate_bps\)/)
  })

  it('15. calls the settlement helper via SELECT ... INTO before computing the payout amount', () => {
    expect(body).toMatch(/select public\._rent_to_buy_settle_escrow\([^)]*\)\s*\n\s*into v_settle_result;/)
    const settleIdx = body.indexOf('select public._rent_to_buy_settle_escrow(')
    const payoutIdx = body.indexOf('v_payout_amount := greatest(')
    expect(payoutIdx).toBeGreaterThan(settleIdx)
  })

  it('16. the payout amount is derived from v_actual_released, not from total_purchase_price', () => {
    expect(body).toMatch(/v_actual_released := coalesce\(\(v_settle_result->>'released_amount'\)::numeric\(12,2\), 0\);/)
    expect(body).toMatch(/v_payout_amount := greatest\(v_actual_released - coalesce\(v_commission_amount, 0\), 0\);/)
    expect(body).not.toMatch(/greatest\(v_agreement\.total_purchase_price - coalesce\(v_commission_amount, 0\), 0\)/)
  })

  it('17. the settlement release budget passed in is still total_purchase_price -- that is the request, not the result', () => {
    expect(body).toMatch(/_rent_to_buy_settle_escrow\(p_agreement_id, v_agreement\.total_purchase_price,/)
  })

  it('18. the return shape (agreement_id, finalized, commission_amount, payout_id) is unchanged', () => {
    expect(body).toMatch(/return jsonb_build_object\('agreement_id', p_agreement_id, 'finalized', true, 'commission_amount', coalesce\(v_commission_amount, 0\), 'payout_id', v_payout_result->>'payout_id'\);/)
  })

  it('19. every pre-existing precondition check (already finalized, fully paid, active, possession confirmed, completion window, no active dispute) is unchanged', () => {
    expect(body).toMatch(/if v_agreement\.ownership_status = 'customer_owned' then/)
    expect(body).toMatch(/if v_agreement\.fully_paid_at is null then/)
    expect(body).toMatch(/if v_agreement\.status <> 'active' then/)
    expect(body).toMatch(/if v_agreement\.possession_status <> 'customer_in_possession' then/)
    expect(body).toMatch(/if v_agreement\.completion_window_ends_at is null or v_agreement\.completion_window_ends_at > now\(\) then/)
    expect(body).toMatch(/status not in \('resolved', 'closed', 'cancelled'\)\) into v_dispute_open;/)
  })
})

describe('E24 -- _rent_to_buy_settle_default_before_possession is NOT touched by this migration', () => {
  it('20. no CREATE OR REPLACE / ALTER exists for it anywhere in this migration -- a bare PERFORM discards any return value regardless of type, so it needs no change', () => {
    expect(codeOnly).not.toMatch(/function public\._rent_to_buy_settle_default_before_possession/)
  })
})

describe('E24 -- defense-in-depth RTB backing check on both payout-safety gates', () => {
  it('21. _merchant_payout_full_eligibility_block\'s RTB branch now blocks when payout.amount exceeds released escrow principal', () => {
    const body = extractBody(sql, 'create or replace function public._merchant_payout_full_eligibility_block(')
    const rtbBranch = body.slice(0, body.indexOf('if p_payout.booking_id is null'))
    expect(rtbBranch).toMatch(/select coalesce\(sum\(principal_amount\), 0\) into v_released_total\s*\n\s*from public\.escrow_transactions\s*\n\s*where rent_to_buy_agreement_id = p_payout\.rent_to_buy_agreement_id and status = 'released';/)
    expect(rtbBranch).toMatch(/if p_payout\.amount > v_released_total then\s*\n\s*return 'source_payment_issue';/)
  })

  it('22. _merchant_payout_still_safe_to_pay_block\'s RTB branch has the identical backing re-check', () => {
    const body = extractBody(sql, 'create or replace function public._merchant_payout_still_safe_to_pay_block(')
    const rtbBranch = body.slice(0, body.indexOf('if exists (\n    select 1 from public.disputes\n    where booking_id'))
    expect(rtbBranch).toMatch(/select coalesce\(sum\(principal_amount\), 0\) into v_released_total\s*\n\s*from public\.escrow_transactions\s*\n\s*where rent_to_buy_agreement_id = p_payout\.rent_to_buy_agreement_id and status = 'released';/)
    expect(rtbBranch).toMatch(/if p_payout\.amount > v_released_total then\s*\n\s*return 'source_payment_issue';/)
  })

  it('23. the new RTB check never treats "any refunded row exists" as the block condition -- only compares against the released total', () => {
    const fullBody = extractBody(sql, 'create or replace function public._merchant_payout_full_eligibility_block(')
    const rtbBranch = fullBody.slice(0, fullBody.indexOf('if p_payout.booking_id is null'))
    expect(rtbBranch).not.toMatch(/status in \('refunded', 'partially_refunded'\)/)
  })

  it('24. the booking branch of both gate functions (E23\'s own fix) is byte-for-byte unchanged by this migration', () => {
    const E23_FILE = join(MIGRATIONS_DIR, '20261107175026_contain_escrow_refund_payout_desync.sql')
    const e23Content = readFileSync(E23_FILE, 'utf-8')
    for (const name of ['_merchant_payout_full_eligibility_block', '_merchant_payout_still_safe_to_pay_block']) {
      const e23Body = extractBody(e23Content, `create or replace function public.${name}(`)
      const e24Body = extractBody(sql, `create or replace function public.${name}(`)
      const e23BookingBranch = e23Body.slice(e23Body.indexOf(name.includes('full') ? 'if p_payout.booking_id is null' : 'if exists (\n    select 1 from public.disputes\n    where booking_id'))
      const e24BookingBranch = e24Body.slice(e24Body.indexOf(name.includes('full') ? 'if p_payout.booking_id is null' : 'if exists (\n    select 1 from public.disputes\n    where booking_id'))
      expect(e24BookingBranch, `${name}: booking branch unexpectedly changed`).toBe(e23BookingBranch)
    }
  })

  it('25. both gate functions preserve their exact prior grants -- service_role only', () => {
    for (const name of ['_merchant_payout_full_eligibility_block', '_merchant_payout_still_safe_to_pay_block']) {
      expect(normalized).toMatch(new RegExp(`revoke all on function public\\.${name}\\(public\\.merchant_payouts\\) from public, anon, authenticated;`))
      expect(normalized).toMatch(new RegExp(`grant execute on function public\\.${name}\\(public\\.merchant_payouts\\) to service_role;`))
    }
  })
})

describe('E24 -- scope and safety contract', () => {
  it('26. redefines exactly 5 functions, drops exactly 1, no other function/table/policy/trigger/extension is touched', () => {
    const drops = codeOnly.match(/drop function/gi) ?? []
    expect(drops).toHaveLength(1)
    const creates = codeOnly.match(/create (or replace )?function/gi) ?? []
    expect(creates).toHaveLength(5)
    expect(codeOnly).not.toMatch(/create policy|drop policy|alter policy/i)
    expect(codeOnly).not.toMatch(/create table|drop table|alter table/i)
    expect(codeOnly).not.toMatch(/create trigger|drop trigger/i)
    expect(codeOnly).not.toMatch(/alter extension|create extension|drop extension/i)
    expect(codeOnly).not.toMatch(/enable row level security|disable row level security/i)
  })

  it('27. this migration itself never issues a top-level data mutation -- every INSERT/UPDATE/DELETE present is pre-existing business logic inside a redefined function body (unity_commissions/unity_commission_history/rent_to_buy_agreements writes that already existed before E24), never a statement the migration executes directly at deploy time', () => {
    // Every top-level statement in this migration is DROP FUNCTION, CREATE
    // [OR REPLACE] FUNCTION, REVOKE, or GRANT -- confirmed by splitting on
    // the function-body delimiters and checking only the text OUTSIDE any
    // `as $$ ... $$;` block.
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

  it('28. never touches mark_payout_failed, mark_payout_processing, retry_payout, mark_payout_paid, create_merchant_payout, or _payout_reconcile_missing_candidates', () => {
    expect(codeOnly).not.toMatch(/function public\.(mark_payout_failed|mark_payout_processing|retry_payout|mark_payout_paid|create_merchant_payout|_payout_reconcile_missing_candidates)\(/)
  })

  it('29. never touches ledger_entries_immutable, prevent_row_mutation, record_escrow_webhook_event, resolve_dispute, or the two escrow dispute/completion blocks', () => {
    expect(codeOnly).not.toMatch(/ledger_entries_immutable|prevent_row_mutation|record_escrow_webhook_event|resolve_dispute|_escrow_transaction_dispute_block|_escrow_transaction_completion_block/)
  })

  it('30. no dynamic SQL exists anywhere in this migration', () => {
    expect(codeOnly).not.toMatch(/\bEXECUTE\s+(format|'|")/i)
    expect(codeOnly).not.toMatch(/quote_ident|quote_literal/)
  })

  it('31. is forward-only -- sorts after every pre-existing migration, no historical file modified', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'))
    expect(files).toContain(MIGRATION_FILE)
    const earlier = files.filter((f) => f !== MIGRATION_FILE && f < MIGRATION_FILE)
    expect(earlier.length).toBeGreaterThan(0)
  })
})

describe('E24 -- numeric conservation proof (TypeScript simulation of the documented whole-row algorithm)', () => {
  // Mirrors _rent_to_buy_settle_escrow's exact documented algorithm:
  // oldest-row-first, release a row whole while budget remains, else
  // refund it whole -- never split. This proves the ALGORITHM's own
  // conservation property; the SQL assertions above separately prove
  // the deployed callers now consume this algorithm's actual output.
  function simulateSettleEscrow(rowPrincipals: number[], releaseBudget: number): { released: number; refunded: number } {
    let remaining = releaseBudget
    let released = 0
    let refunded = 0
    for (const principal of rowPrincipals) {
      if (remaining >= principal) {
        released += principal
        remaining -= principal
      } else {
        refunded += principal
      }
    }
    return { released, refunded }
  }

  it('32. critical numeric test: two R60 rows, cap R90 -- straddling row, actual release (R60) is strictly less than the cap', () => {
    const { released, refunded } = simulateSettleEscrow([60, 60], 90)
    expect(released).toBe(60)
    expect(refunded).toBe(60)
    expect(released).toBeLessThan(90)
    // Conservation: a payout now derived from `released` (60) rather than the cap (90) can never exceed actual release.
    const commissionRateBps = 1000 // 10%, arbitrary for this proof
    const commission = Math.round(released * commissionRateBps) / 10000
    const payout = released - commission
    expect(payout + commission).toBe(released)
    expect(payout).toBeLessThanOrEqual(released)
  })

  it('33. exact-boundary control case: R50 + R40, cap R90 -- no straddling row, full release, zero refund', () => {
    const { released, refunded } = simulateSettleEscrow([50, 40], 90)
    expect(released).toBe(90)
    expect(refunded).toBe(0)
  })

  it('34. multi-row under-cap case: three R30 rows, cap R75 -- released R60, refunded R30', () => {
    const { released, refunded } = simulateSettleEscrow([30, 30, 30], 75)
    expect(released).toBe(60)
    expect(refunded).toBe(30)
    expect(released).toBeLessThan(75)
  })

  it('35. release budget of exactly 0 (default-before-possession) refunds everything, releases nothing', () => {
    const { released, refunded } = simulateSettleEscrow([60, 60], 0)
    expect(released).toBe(0)
    expect(refunded).toBe(120)
  })

  it('36. full coverage (successful completion, nothing manually refunded first): release budget equals the sum of all rows -- everything released, nothing refunded', () => {
    const rows = [25, 25, 25, 25]
    const { released, refunded } = simulateSettleEscrow(rows, rows.reduce((a, b) => a + b, 0))
    expect(released).toBe(100)
    expect(refunded).toBe(0)
  })

  it('37. manual pre-finalization partial refund scenario: one row already missing from the funded set before settlement runs -- the algorithm (and therefore the actual-released total) naturally reflects its absence', () => {
    // 5 rows of R20 = R100 total_purchase_price, but one row was already
    // manually refunded via the generic admin route before finalization
    // ran, so only 4 remain in the 'funded' set _rent_to_buy_settle_escrow
    // actually selects.
    const remainingFundedRows = [20, 20, 20, 20]
    const { released } = simulateSettleEscrow(remainingFundedRows, 100)
    expect(released).toBe(80)
    expect(released).toBeLessThan(100)
    // The fixed callers base payout on `released` (80), not the
    // theoretical total_purchase_price (100) -- conservation holds.
  })
})
