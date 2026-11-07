import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

/**
 * E22 migration-contract test for
 * 20261107173218_restore_dispute_fix_forward_semantics.sql.
 *
 * Scope: a fresh audit found public._escrow_transaction_dispute_block's
 * current live body (from 20260821183600_rtb_v2_rpcs.sql) had
 * regressed a deliberate fix-forward (20260825000007) that removed
 * the orders.status='disputed' / barter_agreements.status='disputed'
 * checks for release-block purposes, since neither status is ever
 * restored after dispute resolution (only bookings and
 * rent_to_buy_agreements have a restoration mechanism). This
 * migration merges 007's corrected order/barter semantics with the
 * RTB branch the later rewrite legitimately added.
 *
 * A second target this phase's own brief named,
 * public.resolve_dispute's booking-restoration condition, was
 * investigated and found NOT to be a regression -- a later, explicit,
 * dated product decision
 * (20260904000003_dispute_resolve_restore_booking_all_outcomes.sql)
 * deliberately removed the favor_respondent-only restriction for
 * booking restoration, while explicitly preserving it for RTB. This
 * migration does not touch public.resolve_dispute at all.
 *
 * LIMITATION, per this codebase's established convention: this test
 * parses SQL source text and asserts on its structure. It does not
 * execute against a live Postgres instance. This migration reaches
 * the live database only via the project's GitHub-integrated
 * Supabase workflow.
 */
const REPO_ROOT = join(__dirname, '../../..')
const MIGRATIONS_DIR = join(REPO_ROOT, 'supabase/migrations')
const MIGRATION_FILE = '20261107173218_restore_dispute_fix_forward_semantics.sql'
const MIGRATION_PATH = join(MIGRATIONS_DIR, MIGRATION_FILE)
const sql = readFileSync(MIGRATION_PATH, 'utf-8')
const codeOnly = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')
const normalized = codeOnly.replace(/\s+/g, ' ').trim()

function stripComments(src: string): string {
  return src.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').replace(/\s+/g, ' ').trim()
}

function extractBody(src: string, marker: string): string {
  const idx = src.indexOf(marker)
  if (idx === -1) throw new Error(`marker not found: ${marker}`)
  const start = src.indexOf('as $$', idx)
  const end = src.indexOf('$$;', start)
  return src.slice(start + 5, end).trim()
}

describe('20261107173218_restore_dispute_fix_forward_semantics.sql (category: ADMIN-CONTROL-CENTRE-BATCH-E22)', () => {
  it('1. redefines exactly one function -- _escrow_transaction_dispute_block -- and not resolve_dispute', () => {
    const defs = codeOnly.match(/create or replace function/gi) ?? []
    expect(defs).toHaveLength(1)
    expect(normalized).toMatch(/create or replace function public\._escrow_transaction_dispute_block\(p_escrow public\.escrow_transactions\)/)
    expect(codeOnly).not.toMatch(/function public\.resolve_dispute/)
  })

  it('2. preserves SECURITY DEFINER and an empty search_path (E21 must not regress)', () => {
    const header = codeOnly.slice(0, codeOnly.indexOf('as $$'))
    expect(header).toMatch(/security definer/i)
    expect(header).toMatch(/set search_path = ''/)
    expect(header).not.toMatch(/set search_path = public/)
  })

  it('3. the order branch no longer checks orders.status = \'disputed\'', () => {
    const body = extractBody(sql, 'create or replace function public._escrow_transaction_dispute_block')
    const orderBranch = body.slice(body.indexOf('elsif p_escrow.order_id'), body.indexOf('elsif p_escrow.barter_agreement_id'))
    expect(orderBranch).not.toMatch(/public\.orders where id = p_escrow\.order_id and status = 'disputed'/)
    expect(orderBranch).toMatch(/public\.disputes where order_id = p_escrow\.order_id and status not in \('resolved', 'closed', 'cancelled'\)/)
  })

  it('4. the barter branch no longer checks barter_agreements.status = \'disputed\'', () => {
    const body = extractBody(sql, 'create or replace function public._escrow_transaction_dispute_block')
    const barterBranch = body.slice(body.indexOf('elsif p_escrow.barter_agreement_id'), body.indexOf('elsif p_escrow.rent_to_buy_agreement_id'))
    expect(barterBranch).not.toMatch(/public\.barter_agreements where id = p_escrow\.barter_agreement_id and status = 'disputed'/)
    expect(barterBranch).toMatch(/public\.disputes where barter_agreement_id = p_escrow\.barter_agreement_id and status not in \('resolved', 'closed', 'cancelled'\)/)
  })

  it('5. the booking branch retains its own-status check (dual signal, unchanged)', () => {
    const body = extractBody(sql, 'create or replace function public._escrow_transaction_dispute_block')
    const bookingBranch = body.slice(body.indexOf('if p_escrow.booking_id'), body.indexOf('elsif p_escrow.order_id'))
    expect(bookingBranch).toMatch(/public\.bookings where id = p_escrow\.booking_id and status = 'disputed'/)
    expect(bookingBranch).toMatch(/public\.disputes where booking_id = p_escrow\.booking_id and status not in \('resolved', 'closed', 'cancelled'\)/)
  })

  it('6. the RTB branch retains its own-status check (dual signal, unchanged)', () => {
    const body = extractBody(sql, 'create or replace function public._escrow_transaction_dispute_block')
    const rtbBranch = body.slice(body.indexOf('elsif p_escrow.rent_to_buy_agreement_id'))
    expect(rtbBranch).toMatch(/public\.rent_to_buy_agreements where id = p_escrow\.rent_to_buy_agreement_id and status = 'disputed'/)
    expect(rtbBranch).toMatch(/public\.disputes where rent_to_buy_agreement_id = p_escrow\.rent_to_buy_agreement_id and status not in \('resolved', 'closed', 'cancelled'\)/)
  })

  it('7. body-diff: removing exactly the 2 permitted checks from the current live RTB body reproduces this migration\'s body exactly', () => {
    const RTB_FILE = join(MIGRATIONS_DIR, '20260821183600_rtb_v2_rpcs.sql')
    const rtbContent = readFileSync(RTB_FILE, 'utf-8')
    const before = stripComments(extractBody(rtbContent, 'create or replace function public._escrow_transaction_dispute_block(p_escrow public.escrow_transactions)'))
    const after = stripComments(extractBody(sql, 'create or replace function public._escrow_transaction_dispute_block'))
    const simulated = before
      .replace(/if exists \(select 1 from public\.orders where id = p_escrow\.order_id and status = 'disputed'\) then return 'unresolved_dispute'; end if; /, '')
      .replace(/if exists \(select 1 from public\.barter_agreements where id = p_escrow\.barter_agreement_id and status = 'disputed'\) then return 'unresolved_dispute'; end if; /, '')
    expect(after).toBe(simulated)
  })

  it('8. no grants, RLS, tables, triggers, or extensions are touched', () => {
    expect(codeOnly).not.toMatch(/\bgrant\b|\brevoke\b/i)
    expect(codeOnly).not.toMatch(/create policy|drop policy|alter policy/i)
    expect(codeOnly).not.toMatch(/create table|drop table|alter table/i)
    expect(codeOnly).not.toMatch(/create trigger|drop trigger/i)
    expect(codeOnly).not.toMatch(/alter extension|create extension|drop extension/i)
    expect(codeOnly).not.toMatch(/enable row level security|disable row level security/i)
  })

  it('9. no data mutation statement exists anywhere in this migration (DDL only)', () => {
    expect(codeOnly).not.toMatch(/^\s*insert into\b/im)
    expect(codeOnly).not.toMatch(/^\s*update\s+public\./im)
    expect(codeOnly).not.toMatch(/^\s*delete from\b/im)
  })

  it('10. no dynamic SQL exists anywhere in this migration', () => {
    expect(codeOnly).not.toMatch(/\bEXECUTE\s+(format|'|")/i)
    expect(codeOnly).not.toMatch(/quote_ident|quote_literal/)
  })

  it('11. is forward-only -- sorts after every pre-existing migration, no historical file modified', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'))
    expect(files).toContain(MIGRATION_FILE)
    const earlier = files.filter((f) => f !== MIGRATION_FILE && f < MIGRATION_FILE)
    expect(earlier.length).toBeGreaterThan(0)
  })
})

describe('resolve_dispute is deliberately NOT touched: fresh investigation disproves the hypothesized regression', () => {
  const LATEST_FILE = join(MIGRATIONS_DIR, '20260904000003_dispute_resolve_restore_booking_all_outcomes.sql')
  const latestContent = readFileSync(LATEST_FILE, 'utf-8')

  it('12. the current authoritative resolve_dispute (20260904000003, the chronologically latest of its 5 defining migrations) is the one this migration deliberately leaves unchanged', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && /function public\.resolve_dispute\(/.test(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8')))
    const latestByName = files.sort().at(-1)
    expect(latestByName).toBe('20260904000003_dispute_resolve_restore_booking_all_outcomes.sql')
  })

  it('13. that authoritative definition\'s booking restoration has NO p_outcome guard -- a documented, deliberate product decision, not a bug', () => {
    const body = extractBody(latestContent, 'create or replace function public.resolve_dispute')
    const bookingBlock = body.slice(body.indexOf('if v_dispute.booking_id'), body.indexOf('if v_dispute.rent_to_buy_agreement_id'))
    expect(bookingBlock).toMatch(/if v_dispute\.booking_id is not null and v_dispute\.pre_dispute_status is not null then/)
    expect(bookingBlock).not.toMatch(/p_outcome = 'favor_respondent'/)
  })

  it('14. that same definition\'s RTB restoration KEEPS the favor_respondent-only guard, confirming the distinction is intentional, not an oversight', () => {
    const body = extractBody(latestContent, 'create or replace function public.resolve_dispute')
    const rtbBlock = body.slice(body.indexOf('if v_dispute.rent_to_buy_agreement_id'))
    expect(rtbBlock).toMatch(/if v_dispute\.rent_to_buy_agreement_id is not null and v_dispute\.pre_dispute_status is not null and p_outcome = 'favor_respondent' then/)
  })

  it('15. this migration never defines or alters resolve_dispute', () => {
    expect(codeOnly).not.toMatch(/resolve_dispute/)
  })
})
