import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

/**
 * E26 migration-contract test for
 * 20261108105222_restore_rtb_optional_escrow_compatibility.sql.
 *
 * Scope: a fresh, live-data-confirmed audit found that the prior
 * phase's actual-released-escrow-principal conservation (E24) was
 * applied unconditionally, even to RTB agreements that never had an
 * escrow_transactions row at all (the documented "optional escrow"
 * default -- ESCROW_ENABLED unset/false). For those agreements,
 * public._rent_to_buy_settle_escrow correctly reports 0 released
 * (zero rows to iterate), but E24's callers then treated that 0 as
 * "nothing was ever recovered", permanently blocking every no-escrow
 * RTB merchant payout and silently skipping commission/payout
 * creation for every new no-escrow settlement.
 *
 * Fix: every one of the 4 affected functions now derives an explicit
 * v_has_escrow flag from row EXISTENCE (any status) for the
 * agreement, never from the ESCROW_ENABLED env var and never from
 * whether any existing row's released/funded total happens to be
 * zero. In NO_ESCROW mode, the pre-E24 legacy, escrow-independent
 * formula is restored exactly. In ESCROW_PARTICIPATING mode (one or
 * more rows, any status), E24's actual-released-principal authority
 * is fully retained, unchanged.
 *
 * LIMITATION, per this codebase's established convention: this test
 * parses SQL source text and asserts on its structure. It does not
 * execute against a live Postgres instance. This migration reaches
 * the live database only via the project's GitHub-integrated
 * Supabase workflow.
 */
const REPO_ROOT = join(__dirname, '../../..')
const MIGRATIONS_DIR = join(REPO_ROOT, 'supabase/migrations')
const MIGRATION_FILE = '20261108105222_restore_rtb_optional_escrow_compatibility.sql'
const MIGRATION_PATH = join(MIGRATIONS_DIR, MIGRATION_FILE)
const sql = readFileSync(MIGRATION_PATH, 'utf-8')
const codeOnly = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')
const normalized = codeOnly.replace(/\s+/g, ' ').trim()

const E24_FILE = join(MIGRATIONS_DIR, '20261107190421_harden_rtb_escrow_payout_conservation.sql')
const e24Sql = readFileSync(E24_FILE, 'utf-8')

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

describe('20261108105222_restore_rtb_optional_escrow_compatibility.sql (category: ADMIN-CONTROL-CENTRE-BATCH-E26)', () => {
  it('1. redefines exactly 4 functions -- the 2 settlement functions and the 2 payout-safety gates -- drops none, no other object touched', () => {
    const creates = codeOnly.match(/create (or replace )?function/gi) ?? []
    expect(creates).toHaveLength(4)
    expect(codeOnly).not.toMatch(/drop function/i)
    for (const name of [
      '_rent_to_buy_settle_default_after_possession',
      'finalize_rent_to_buy_ownership',
      '_merchant_payout_full_eligibility_block',
      '_merchant_payout_still_safe_to_pay_block',
    ]) {
      expect(normalized).toMatch(new RegExp(`create or replace function public\\.${name}\\(`))
    }
    expect(codeOnly).not.toMatch(/create policy|drop policy|alter policy/i)
    expect(codeOnly).not.toMatch(/create table|drop table|alter table/i)
    expect(codeOnly).not.toMatch(/create trigger|drop trigger/i)
    expect(codeOnly).not.toMatch(/alter extension|create extension|drop extension/i)
    expect(codeOnly).not.toMatch(/enable row level security|disable row level security/i)
  })

  it('2. never touches _rent_to_buy_settle_escrow or _rent_to_buy_settle_default_before_possession -- the brief\'s own preference not to modify the settlement primitive or the before-possession path', () => {
    expect(codeOnly).not.toMatch(/function public\._rent_to_buy_settle_escrow\(/)
    expect(codeOnly).not.toMatch(/function public\._rent_to_buy_settle_default_before_possession\(/)
  })

  it('3. never redefines create_merchant_payout, mark_payout_failed, mark_payout_processing, retry_payout, mark_payout_paid, record_escrow_webhook_event, resolve_dispute, or the escrow dispute/completion blocks, and never references ledger_entries -- the pre-existing "perform public.create_merchant_payout(...)" call inside a redefined body is expected and excluded', () => {
    expect(codeOnly).not.toMatch(/ledger_entries|record_escrow_webhook_event|resolve_dispute|_escrow_transaction_dispute_block|_escrow_transaction_completion_block/)
    expect(codeOnly).not.toMatch(/function public\.(create_merchant_payout|mark_payout_failed|mark_payout_processing|retry_payout|mark_payout_paid)\(/)
  })

  it('4. never re-enables escrow partial refunds -- introduces zero NEW "partially_refunded" references beyond the pre-existing E23 booking-branch check this migration must restate verbatim, and no refund_escrow_transaction reference anywhere', () => {
    const occurrences = codeOnly.match(/partially_refunded/g) ?? []
    // Exactly the 3 pre-existing booking-branch occurrences carried forward
    // unchanged because CREATE OR REPLACE requires restating the whole
    // body -- never a new one: _merchant_payout_full_eligibility_block's
    // E23 escrow check (1), and _merchant_payout_still_safe_to_pay_block's
    // own pre-E23 payment-status check plus its E23 escrow check (2).
    expect(occurrences).toHaveLength(3)
    expect(codeOnly).not.toMatch(/refund_escrow_transaction/)
  })

  it('5. this migration itself never issues a top-level data mutation -- every INSERT/UPDATE/DELETE present is pre-existing business logic inside a redefined function body, never a statement the migration executes directly at deploy time', () => {
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

  it('6. no dynamic SQL exists anywhere in this migration', () => {
    expect(codeOnly).not.toMatch(/\bEXECUTE\s+(format|'|")/i)
    expect(codeOnly).not.toMatch(/quote_ident|quote_literal/)
  })

  it('7. is forward-only -- sorts after every pre-existing migration, no historical file modified', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'))
    expect(files).toContain(MIGRATION_FILE)
    const earlier = files.filter((f) => f !== MIGRATION_FILE && f < MIGRATION_FILE)
    expect(earlier.length).toBeGreaterThan(0)
  })

  it('8. both payout-safety gates preserve their exact prior grants -- service_role only, no widening', () => {
    for (const name of ['_merchant_payout_full_eligibility_block', '_merchant_payout_still_safe_to_pay_block']) {
      expect(normalized).toMatch(new RegExp(`revoke all on function public\\.${name}\\(public\\.merchant_payouts\\) from public, anon, authenticated;`))
      expect(normalized).toMatch(new RegExp(`grant execute on function public\\.${name}\\(public\\.merchant_payouts\\) to service_role;`))
    }
  })

  it('9. both settlement functions preserve SECURITY DEFINER and search_path = public', () => {
    for (const name of ['_rent_to_buy_settle_default_after_possession', 'finalize_rent_to_buy_ownership']) {
      const header = normalized.slice(normalized.indexOf(`create or replace function public.${name}(`), normalized.indexOf('as $$', normalized.indexOf(`create or replace function public.${name}(`)))
      expect(header, name).toMatch(/security definer/i)
      expect(header, name).toMatch(/set search_path = public/i)
    }
  })
})

describe('E26 -- mode determination is based on row existence, never on ESCROW_ENABLED or on a zero total', () => {
  it('10. all 4 functions compute v_has_escrow via a plain EXISTS against escrow_transactions scoped to the agreement, with no status filter', () => {
    for (const marker of [
      'create or replace function public._rent_to_buy_settle_default_after_possession(',
      'create or replace function public.finalize_rent_to_buy_ownership(',
      'create or replace function public._merchant_payout_full_eligibility_block(',
      'create or replace function public._merchant_payout_still_safe_to_pay_block(',
    ]) {
      const body = extractBody(sql, marker)
      expect(body, marker).toMatch(/select exists \(select 1 from public\.escrow_transactions where rent_to_buy_agreement_id = [\w.]+\) into v_has_escrow;/)
    }
  })

  it('11. no function ever reads process.env, current_setting, or any ESCROW_ENABLED-shaped value to decide the mode', () => {
    expect(codeOnly).not.toMatch(/ESCROW_ENABLED/)
    expect(codeOnly).not.toMatch(/current_setting\(/)
  })

  it('12. the existence check never filters by status -- a failed/cancelled/refunded-only row must still count as participation', () => {
    const matches = codeOnly.match(/select exists \(select 1 from public\.escrow_transactions where rent_to_buy_agreement_id = [\w.]+\) into v_has_escrow;/g) ?? []
    expect(matches.length).toBe(4)
    for (const m of matches) {
      expect(m).not.toMatch(/status/)
    }
  })
})

describe('E26 -- _rent_to_buy_settle_default_after_possession: legacy recovery formula restored for no-escrow mode, escrow mode unchanged', () => {
  const body = extractBody(sql, 'create or replace function public._rent_to_buy_settle_default_after_possession(')

  it('13. v_recovered_amount is still least(rental_use_amount, held_total) -- the capped recovery formula itself is untouched', () => {
    expect(body).toMatch(/v_recovered_amount := least\(v_rental_use_amount, v_held_total\);/)
  })

  it('14. still calls _rent_to_buy_settle_escrow with the recovery cap as the release budget, unconditionally (both modes)', () => {
    expect(body).toMatch(/select public\._rent_to_buy_settle_escrow\(p_agreement_id, v_recovered_amount,/)
  })

  it('15. overrides v_actual_released to v_recovered_amount when not v_has_escrow -- restoring the exact pre-E24 authority for the no-escrow case', () => {
    expect(body).toMatch(/if not v_has_escrow then[\s\S]{0,400}v_actual_released := v_recovered_amount;[\s\S]{0,40}end if;/)
  })

  it('16. when v_has_escrow is true, v_actual_released keeps E24\'s actual-released value from the settlement call -- never silently reassigned', () => {
    const noEscrowBlock = body.match(/if not v_has_escrow then[\s\S]*?end if;/)?.[0] ?? ''
    expect(noEscrowBlock).not.toMatch(/else/)
  })

  it('17. commission and payout are still gated on v_actual_released > 0 / the net > 0, exactly as E24 left them', () => {
    expect(body).toMatch(/if v_actual_released > 0 and v_agreement\.rental_commission_rate_bps is not null/)
    expect(body).toMatch(/if v_actual_released - coalesce\(v_commission_amount, 0\) > 0 then/)
  })

  it('18. commission eligible_base and payout amount both still derive from v_actual_released, not from a separately-reintroduced legacy variable -- the single override point is the only change', () => {
    expect(body).toMatch(/_calculate_unity_commission\('rental', v_actual_released, v_agreement\.rental_commission_rate_bps\)/)
    expect(body).toMatch(/v_actual_released,\s*\n\s*v_agreement\.rental_commission_rate_bps, v_calc\.standard_rate_base, 0, 0,\s*\n\s*v_commission_amount,/)
    expect(body).toMatch(/perform public\.create_merchant_payout\(v_agreement\.merchant_id, null, v_actual_released - v_commission_amount, null, p_agreement_id\);/)
  })
})

describe('E26 -- finalize_rent_to_buy_ownership: legacy total_purchase_price payout authority restored for no-escrow mode, commission base unaffected', () => {
  const body = extractBody(sql, 'create or replace function public.finalize_rent_to_buy_ownership(')

  it('19. commission base (v_eligible_base) is still the possession-period rental/use amount -- confirmed escrow-independent before and after, untouched by this migration', () => {
    expect(body).toMatch(/v_eligible_base := public\._rent_to_buy_rental_use_amount\(v_agreement, v_agreement\.possession_confirmed_at, now\(\)\);/)
  })

  it('20. still calls _rent_to_buy_settle_escrow with total_purchase_price as the release budget, unconditionally (both modes)', () => {
    expect(body).toMatch(/select public\._rent_to_buy_settle_escrow\(p_agreement_id, v_agreement\.total_purchase_price,/)
  })

  it('21. overrides v_actual_released to total_purchase_price when not v_has_escrow -- restoring the exact pre-E24 payout authority for the no-escrow case', () => {
    expect(body).toMatch(/if not v_has_escrow then[\s\S]{0,400}v_actual_released := v_agreement\.total_purchase_price;[\s\S]{0,40}end if;/)
  })

  it('22. v_payout_amount is still greatest(v_actual_released - commission, 0) -- the payout formula shape itself is unchanged by this migration', () => {
    expect(body).toMatch(/v_payout_amount := greatest\(v_actual_released - coalesce\(v_commission_amount, 0\), 0\);/)
  })
})

describe('E26 -- straddling-cap scenario (E24\'s own numeric proof) is unaffected for a genuinely escrow-participating agreement', () => {
  it('23. when v_has_escrow is true, neither settlement function reassigns v_actual_released away from the settlement call\'s own output -- the straddling-cap conservation (actual release can be strictly less than the theoretical budget) is fully preserved', () => {
    for (const marker of [
      'create or replace function public._rent_to_buy_settle_default_after_possession(',
      'create or replace function public.finalize_rent_to_buy_ownership(',
    ]) {
      const body = extractBody(sql, marker)
      const settleIdx = body.indexOf('into v_settle_result;')
      const overrideBlock = body.slice(settleIdx, body.indexOf('end if;', body.indexOf('if not v_has_escrow then', settleIdx)) + 'end if;'.length)
      expect(overrideBlock).toMatch(/if not v_has_escrow then/)
      // the override block must be the ONLY place v_actual_released is reassigned after the settle call
      const afterOverride = body.slice(overrideBlock.length + settleIdx)
      expect(afterOverride.match(/v_actual_released\s*:=/g) ?? []).toHaveLength(0)
    }
  })
})

describe('E26 -- both payout-safety gates: released-principal backing check scoped to escrow-participating mode only', () => {
  it('24. _merchant_payout_full_eligibility_block wraps the released-total backing check in "if v_has_escrow then ... end if;"', () => {
    const body = extractBody(sql, 'create or replace function public._merchant_payout_full_eligibility_block(')
    expect(body).toMatch(/if v_has_escrow then\s*\n\s*select coalesce\(sum\(principal_amount\), 0\) into v_released_total\s*\n\s*from public\.escrow_transactions\s*\n\s*where rent_to_buy_agreement_id = p_payout\.rent_to_buy_agreement_id and status = 'released';\s*\n\s*if p_payout\.amount > v_released_total then\s*\n\s*return 'source_payment_issue';\s*\n\s*end if;\s*\n\s*end if;/)
  })

  it('25. _merchant_payout_still_safe_to_pay_block has the identical wrapped backing re-check', () => {
    const body = extractBody(sql, 'create or replace function public._merchant_payout_still_safe_to_pay_block(')
    expect(body).toMatch(/if v_has_escrow then\s*\n\s*select coalesce\(sum\(principal_amount\), 0\) into v_released_total\s*\n\s*from public\.escrow_transactions\s*\n\s*where rent_to_buy_agreement_id = p_payout\.rent_to_buy_agreement_id and status = 'released';\s*\n\s*if p_payout\.amount > v_released_total then\s*\n\s*return 'source_payment_issue';\s*\n\s*end if;\s*\n\s*end if;/)
  })

  it('26. the comparison operator and the "released" status filter are identical in substance to E24 -- the fix only wraps the check in a new guard (re-indenting it one level deeper), never changes the comparison itself', () => {
    const normalizeWhitespace = (s: string) => s.replace(/\s+/g, ' ').trim()
    for (const name of ['_merchant_payout_full_eligibility_block', '_merchant_payout_still_safe_to_pay_block']) {
      const e24Body = extractBody(e24Sql, `create or replace function public.${name}(`)
      const e26Body = extractBody(sql, `create or replace function public.${name}(`)
      const e24Check = e24Body.match(/select coalesce\(sum\(principal_amount\), 0\) into v_released_total[\s\S]*?return 'source_payment_issue';\s*\n\s*end if;/)?.[0]
      const e26Check = e26Body.match(/select coalesce\(sum\(principal_amount\), 0\) into v_released_total[\s\S]*?return 'source_payment_issue';\s*\n\s*end if;/)?.[0]
      expect(e24Check, `${name}: E24 backing check not found`).toBeTruthy()
      expect(e26Check, `${name}: E26 backing check not found`).toBeTruthy()
      expect(normalizeWhitespace(e26Check!)).toBe(normalizeWhitespace(e24Check!))
    }
  })

  it('27. the booking branch (E23\'s own fix) of both gate functions is byte-for-byte unchanged by this migration', () => {
    for (const name of ['_merchant_payout_full_eligibility_block', '_merchant_payout_still_safe_to_pay_block']) {
      const e24Body = extractBody(e24Sql, `create or replace function public.${name}(`)
      const e26Body = extractBody(sql, `create or replace function public.${name}(`)
      const e24Booking = stripComments(e24Body.slice(e24Body.indexOf('if p_payout.booking_id is null')))
      const e26Booking = stripComments(e26Body.slice(e26Body.indexOf('if p_payout.booking_id is null')))
      expect(e26Booking, name).toBe(e24Booking)
    }
  })

  it('28. an agreement-status/dispute/merchant-restriction check never depends on v_has_escrow -- those checks run unconditionally in both modes, before the escrow-scoped block', () => {
    for (const marker of [
      'create or replace function public._merchant_payout_full_eligibility_block(',
      'create or replace function public._merchant_payout_still_safe_to_pay_block(',
    ]) {
      const body = extractBody(sql, marker)
      const hasEscrowIdx = body.indexOf('into v_has_escrow;')
      const before = body.slice(0, hasEscrowIdx)
      // full-eligibility block checks agreement status before the escrow block; still-safe-to-pay checks dispute/restriction before it.
      expect(before.includes('v_agreement.status') || before.includes('disputes') || before.includes('account_status')).toBe(true)
    }
  })
})

describe('E26 -- live production regression this migration resolves (71 pending RTB payouts, 70 of them no-escrow)', () => {
  it('29. a no-escrow agreement\'s payout is no longer compared against a hardcoded zero released total -- simulated: v_has_escrow=false means the backing check never executes, so p_payout.amount > 0 can no longer trigger source_payment_issue solely for absence of escrow', () => {
    const body = extractBody(sql, 'create or replace function public._merchant_payout_full_eligibility_block(')
    const rtbBranch = body.slice(0, body.indexOf('if p_payout.booking_id is null'))
    const guardedCheck = rtbBranch.match(/if v_has_escrow then[\s\S]*?end if;/)?.[0] ?? ''
    expect(guardedCheck).toMatch(/v_released_total/)
    // outside the guarded block, v_released_total is never compared against p_payout.amount
    const outsideGuard = rtbBranch.replace(guardedCheck, '')
    expect(outsideGuard).not.toMatch(/p_payout\.amount > v_released_total/)
  })
})

describe('E26 -- mixed/partial escrow coverage always classifies as ESCROW_PARTICIPATING, never falls back to legacy', () => {
  it('30. v_has_escrow is a plain boolean from EXISTS -- there is no secondary condition (e.g. comparing row count to installment count) that could flip a partially-covered agreement back to the no-escrow branch', () => {
    const body = extractBody(sql, 'create or replace function public._rent_to_buy_settle_default_after_possession(')
    expect(body).not.toMatch(/count\(\*\)[\s\S]*escrow_transactions[\s\S]*rent_to_buy_installments|installments[\s\S]*count[\s\S]*escrow_transactions/)
    expect(body).toMatch(/v_has_escrow boolean;/)
  })
})

describe('E26 -- concurrency: no new escrow row can appear between the mode determination and its use, documented explicitly', () => {
  it('31. the migration\'s own header comment documents the concurrency reasoning rather than silently omitting it', () => {
    expect(sql).toMatch(/Concurrency:/)
    expect(sql).toMatch(/create_rent_to_buy_payment_intent/)
  })

  it('32. finalize_rent_to_buy_ownership structurally forecloses new installment payments before its v_has_escrow read -- it requires fully_paid_at is not null, which is only set once no installment remains scheduled', () => {
    const body = extractBody(sql, 'create or replace function public.finalize_rent_to_buy_ownership(')
    const fullyPaidIdx = body.indexOf('fully_paid_at is null')
    const hasEscrowIdx = body.indexOf('into v_has_escrow;')
    expect(fullyPaidIdx).toBeGreaterThan(-1)
    expect(hasEscrowIdx).toBeGreaterThan(fullyPaidIdx)
  })
})

describe('pre-existing fact check: create_rent_to_buy_payment_intent has no agreement-level status/settled_at/fully_paid_at guard (only the targeted installment\'s own status)', () => {
  it('33. the authoritative definition only checks the installment row\'s own status = scheduled, confirming the concurrency note\'s premise', () => {
    const DEFINING_FILE = join(MIGRATIONS_DIR, '20260926090000_harden_rtb_payoff_snapshot_and_completion.sql')
    const content = readFileSync(DEFINING_FILE, 'utf-8')
    const body = extractBody(content, 'create or replace function public.create_rent_to_buy_payment_intent(')
    expect(body).not.toMatch(/v_agreement\.(status|settled_at|fully_paid_at)/)
    expect(body).toMatch(/status\s*<>\s*'scheduled'|status\s*=\s*'scheduled'/)
  })
})
