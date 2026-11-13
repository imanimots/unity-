import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * E33 migration-contract test for
 * 20261112134448_add_peach_payout_execution.sql.
 *
 * Scope: real Peach payout execution (merchant + affiliate), bound to
 * an immutable E32 destination snapshot, with a unified provider-
 * attempt ledger, a single shared "apply provider truth" authority per
 * domain, and a manual-flow conflict guard -- while production stays
 * fail-closed (enforced in TypeScript, not this migration).
 *
 * LIMITATION, per this codebase's established convention: this test
 * parses SQL source text and asserts on its structure. It does not
 * execute against a live Postgres instance.
 */
const REPO_ROOT = join(__dirname, '../../..')
const MIGRATIONS_DIR = join(REPO_ROOT, 'supabase/migrations')
const MIGRATION_FILE = '20261112134448_add_peach_payout_execution.sql'
const MIGRATION_PATH = join(MIGRATIONS_DIR, MIGRATION_FILE)
const sql = readFileSync(MIGRATION_PATH, 'utf-8')
const codeOnly = sql
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n')
const normalized = codeOnly.replace(/\s+/g, ' ').trim()

function extractBody(src: string, marker: string): string {
  const idx = src.indexOf(marker)
  if (idx === -1) throw new Error(`marker not found: ${marker}`)
  const start = src.indexOf('as $$', idx)
  const end = src.indexOf('$$;', start)
  return src.slice(start + 5, end).trim()
}

describe('20261112134448_add_peach_payout_execution.sql (category: ADMIN-CONTROL-CENTRE-BATCH-E33)', () => {
  it('1. adds "reversed" to payout_status idempotently', () => {
    expect(normalized).toMatch(/alter type public\.payout_status add value if not exists 'reversed';/)
  })

  it('2. widens merchant_payouts.payout_method to include "peach" without narrowing the existing allowed values', () => {
    expect(normalized).toMatch(/check \(payout_method is null or payout_method in \('manual', 'mock_validation', 'peach'\)\);/)
  })

  it('3. adds payout_banks.peach_payout_bank_name additively (nullable, no existing column dropped)', () => {
    expect(normalized).toMatch(/alter table public\.payout_banks add column if not exists peach_payout_bank_name text;/)
  })

  it("4. maps the exact, live-confirmed Peach bankName enum string for a representative sample of banks", () => {
    expect(normalized).toMatch(/\('fnb', 'FNB'\)/)
    expect(normalized).toMatch(/\('gotyme_bank', 'TYMEBANK'\)/)
    expect(normalized).toMatch(/\('enl_mutual_bank', 'YWBN MUTUAL BANK'\)/)
    expect(normalized).toMatch(/\('bank_zero_mukuru', 'BANK ZERO - MUKURU'\)/)
    expect(normalized).toMatch(/\('absa', 'ABSA'\)/)
  })

  it('5. does NOT map mukuru, mercantile_bank, or rand_merchant_bank -- confirmed absent from the live bankName enum, so they must stay NULL (cannot be submitted for real-time EFT) even though E32 marked them payout_supported', () => {
    expect(normalized).not.toMatch(/\('mukuru', '[A-Z]/)
    expect(normalized).not.toMatch(/\('mercantile_bank', '[A-Z]/)
    expect(normalized).not.toMatch(/\('rand_merchant_bank', '[A-Z]/)
  })

  it('6. the bank-name mapping touches exactly 25 banks, matching the live-confirmed enum count', () => {
    const start = normalized.indexOf('update public.payout_banks set peach_payout_bank_name')
    const end = normalized.indexOf(') as v(bank_code, bank_name)', start)
    const body = normalized.slice(start, end)
    const rows = body.match(/\('[a-z_0-9]+', '[^']+'\)/g) ?? []
    expect(rows.length).toBe(25)
  })

  it('7. creates exactly one new table: payout_provider_attempts', () => {
    expect(normalized).toMatch(/create table if not exists public\.payout_provider_attempts \(/)
  })

  it('8. enforces exactly one domain FK via a CHECK constraint, never a polymorphic entity_type/entity_id pair', () => {
    expect(normalized).toMatch(/constraint payout_provider_attempts_one_domain_fk_chk check \(\s*\(merchant_payout_id is not null and affiliate_commission_id is null\) or\s*\(merchant_payout_id is null and affiliate_commission_id is not null\)\s*\)/)
    expect(normalized).not.toMatch(/entity_type/)
  })

  it('9. payout_provider_attempts has no raw bank data columns -- no account number, no accountHolder, no vault pointer, no access token/client secret', () => {
    const start = normalized.indexOf('create table if not exists public.payout_provider_attempts')
    const end = normalized.indexOf(');', start)
    const body = normalized.slice(start, end)
    expect(body).not.toMatch(/account_number|account_holder|access_token|client_secret|vault_secret/)
  })

  it('10. provider_payout_id is treated as mandatory-unique now (provider, provider_payout_id)', () => {
    expect(normalized).toMatch(/create unique index if not exists payout_provider_attempts_provider_payout_id_idx\s+on public\.payout_provider_attempts \(provider, provider_payout_id\);/)
  })

  it('11. enforces at most one nonterminal (pending/processing) attempt per merchant_payout_id via a real partial unique index', () => {
    expect(normalized).toMatch(
      /create unique index if not exists payout_provider_attempts_merchant_active_idx\s+on public\.payout_provider_attempts \(merchant_payout_id\)\s+where merchant_payout_id is not null and provider_status in \('pending', 'processing'\);/
    )
  })

  it('12. enforces at most one nonterminal attempt per affiliate_commission_id via the matching partial unique index', () => {
    expect(normalized).toMatch(
      /create unique index if not exists payout_provider_attempts_affiliate_active_idx\s+on public\.payout_provider_attempts \(affiliate_commission_id\)\s+where affiliate_commission_id is not null and provider_status in \('pending', 'processing'\);/
    )
  })

  it('13. RLS is enabled on payout_provider_attempts with an explicit deny-all policy (not zero policies) and explicit client revokes, matching the E32-R1 idiom', () => {
    expect(normalized).toMatch(/alter table public\.payout_provider_attempts enable row level security;/)
    expect(normalized).toMatch(/create policy "payout_provider_attempts: deny all client access"\s+on public\.payout_provider_attempts for all\s+to public\s+using \(false\)\s+with check \(false\);/)
    expect(normalized).toMatch(/revoke all on public\.payout_provider_attempts from public, anon, authenticated;/)
  })

  it('14. payout_provider_attempts has NO owner-read policy at all -- unlike payout_destinations, this is operational financial-execution authority, server/admin-only', () => {
    const start = normalized.indexOf('create table if not exists public.payout_provider_attempts')
    const end = normalized.indexOf('-- ====', start)
    const body = normalized.slice(start, end === -1 ? undefined : end)
    const policyCount = (body.match(/create policy/g) ?? []).length
    expect(policyCount).toBe(1)
  })

  it('15. no new function introduces an auth.role() caller guard -- continuing the E32-R1 lesson (grant/revoke is the sole boundary)', () => {
    const newFunctionMarkers = [
      'create or replace function public._merchant_payout_ledger_currency(',
      'create or replace function public._payout_provider_attempts_has_active(',
      'create or replace function public.start_merchant_payout_provider_attempt(',
      'create or replace function public.complete_merchant_payout_provider_attempt(',
      'create or replace function public.start_affiliate_payout_provider_attempt(',
      'create or replace function public.complete_affiliate_payout_provider_attempt(',
    ]
    for (const marker of newFunctionMarkers) {
      const body = extractBody(sql, marker)
      expect(body, `${marker} must not contain auth.role()`).not.toMatch(/auth\.role\(\)/)
    }
  })

  it('16. every new function uses search_path = \'\'', () => {
    const newFunctionMarkers = [
      'public._merchant_payout_ledger_currency',
      'public._payout_provider_attempts_has_active',
      'public.start_merchant_payout_provider_attempt',
      'public.complete_merchant_payout_provider_attempt',
      'public.start_affiliate_payout_provider_attempt',
      'public.complete_affiliate_payout_provider_attempt',
    ]
    for (const marker of newFunctionMarkers) {
      const idx = normalized.indexOf(`create or replace function ${marker}(`)
      expect(idx, `missing function ${marker}`).toBeGreaterThan(-1)
      const chunk = normalized.slice(idx, idx + 400)
      expect(chunk, `${marker} must use search_path = ''`).toMatch(/set search_path = ''/)
    }
  })

  it('17. every new function revokes public/anon/authenticated and grants only service_role', () => {
    const functions: Array<[string, string]> = [
      ['public._merchant_payout_ledger_currency', 'uuid'],
      ['public._payout_provider_attempts_has_active', 'uuid, uuid'],
      ['public.start_merchant_payout_provider_attempt', 'uuid, uuid, text'],
      ['public.complete_merchant_payout_provider_attempt', 'uuid, text, text, uuid, timestamptz, text'],
      ['public.start_affiliate_payout_provider_attempt', 'uuid, text'],
      ['public.complete_affiliate_payout_provider_attempt', 'uuid, text, text, uuid, timestamptz, text'],
      ['public.mark_payout_paid', 'uuid, uuid, text, text, boolean, text, text'],
      ['public.mark_payout_failed', 'uuid, uuid, text, text, text'],
      ['public.retry_payout', 'uuid, uuid, text, text'],
    ]
    for (const [name, args] of functions) {
      const escaped = `${name}(${args})`.replace(/[.()]/g, (m) => `\\${m}`)
      expect(normalized, `missing revoke for ${name}`).toMatch(new RegExp(`revoke all on function ${escaped} from public, anon, authenticated;`))
      expect(normalized, `missing service_role grant for ${name}`).toMatch(new RegExp(`grant execute on function ${escaped} to service_role;`))
    }
  })

  it('18. start_merchant_payout_provider_attempt only starts from pending or failed', () => {
    const body = extractBody(sql, 'create or replace function public.start_merchant_payout_provider_attempt(')
    expect(body).toMatch(/v_payout\.status not in \('pending', 'failed'\)/)
  })

  it('19. start_merchant_payout_provider_attempt calls the canonical eligibility gate rather than re-encoding it', () => {
    const body = extractBody(sql, 'create or replace function public.start_merchant_payout_provider_attempt(')
    expect(body).toMatch(/public\._merchant_payout_full_eligibility_block\(v_payout\)/)
  })

  it('20. start_merchant_payout_provider_attempt proves ledger currency is exactly ZAR, failing closed if absent or different', () => {
    const body = extractBody(sql, 'create or replace function public.start_merchant_payout_provider_attempt(')
    expect(body).toMatch(/v_currency := public\._merchant_payout_ledger_currency\(p_payout_id\);/)
    expect(body).toMatch(/if v_currency is null then\s+raise exception 'no ledger currency record found/)
    expect(body).toMatch(/if v_currency <> 'ZAR' then/)
  })

  it('21. start_merchant_payout_provider_attempt calls the E32 destination eligibility RPC unchanged and requires eligible=true', () => {
    const body = extractBody(sql, 'create or replace function public.start_merchant_payout_provider_attempt(')
    expect(body).toMatch(/public\._payout_destination_eligibility\(v_payout\.merchant_id\)/)
    expect(body).toMatch(/if not \(v_destination_elig ->> 'eligible'\)::boolean then/)
  })

  it('22. start_merchant_payout_provider_attempt requires a confirmed peach_payout_bank_name mapping, not just the general payout_supported flag', () => {
    const body = extractBody(sql, 'create or replace function public.start_merchant_payout_provider_attempt(')
    expect(body).toMatch(/pb\.peach_payout_bank_name into v_bank_name/)
    expect(body).toMatch(/if v_bank_name is null then\s+raise exception 'destination bank has no confirmed Peach payout bankName mapping/)
  })

  it('23. start_merchant_payout_provider_attempt computes minor units via exact Postgres numeric math (no floating point) and validates the documented 1-500,000,000 range', () => {
    const body = extractBody(sql, 'create or replace function public.start_merchant_payout_provider_attempt(')
    expect(body).toMatch(/v_amount_minor_units := round\(v_payout\.amount \* 100\);/)
    expect(body).toMatch(/if v_amount_minor_units < 1 or v_amount_minor_units > 500000000 then/)
  })

  it('24. start_merchant_payout_provider_attempt generates the provider_payout_id (gen_random_uuid) and persists it in the same transaction as the insert, before any caller could have made an HTTP call', () => {
    const body = extractBody(sql, 'create or replace function public.start_merchant_payout_provider_attempt(')
    expect(body).toMatch(/v_provider_payout_id uuid := gen_random_uuid\(\);/)
    const declareIdx = body.indexOf('v_provider_payout_id uuid := gen_random_uuid();')
    const insertIdx = body.indexOf('insert into public.payout_provider_attempts')
    expect(declareIdx).toBeGreaterThan(-1)
    expect(insertIdx).toBeGreaterThan(declareIdx)
  })

  it('25. start_merchant_payout_provider_attempt maps a concurrent-start race to a clear retry error instead of a raw constraint message', () => {
    const body = extractBody(sql, 'create or replace function public.start_merchant_payout_provider_attempt(')
    expect(body).toMatch(/when unique_violation then\s+raise exception 'a concurrent provider-attempt start is already in progress for this payout/)
  })

  it('26. start_merchant_payout_provider_attempt transitions pending/failed -> processing atomically in the same call as the attempt insert (never a second round trip)', () => {
    const body = extractBody(sql, 'create or replace function public.start_merchant_payout_provider_attempt(')
    const insertIdx = body.indexOf('insert into public.payout_provider_attempts')
    const transitionIdx = body.indexOf("_merchant_payout_transition(\n    p_payout_id, 'processing', array['pending', 'failed']")
    expect(insertIdx).toBeGreaterThan(-1)
    expect(transitionIdx).toBeGreaterThan(insertIdx)
  })

  it('27. complete_merchant_payout_provider_attempt is idempotent on a duplicate terminal result for the same attempt', () => {
    const body = extractBody(sql, 'create or replace function public.complete_merchant_payout_provider_attempt(')
    expect(body).toMatch(/v_attempt\.resolved_at is not null and v_attempt\.provider_status = p_provider_status/)
    expect(body).toMatch(/'duplicate', true/)
  })

  it('28. complete_merchant_payout_provider_attempt ignores an out-of-order (older-or-equal) provider_last_updated_at rather than regressing state', () => {
    const body = extractBody(sql, 'create or replace function public.complete_merchant_payout_provider_attempt(')
    expect(body).toMatch(/p_provider_last_updated_at <= v_attempt\.provider_last_updated_at/)
    expect(body).toMatch(/'ignored_out_of_order', true/)
  })

  it('29. complete_merchant_payout_provider_attempt never transitions the domain row for a non-terminal (pending/processing) provider status', () => {
    const body = extractBody(sql, 'create or replace function public.complete_merchant_payout_provider_attempt(')
    expect(body).toMatch(/if p_provider_status in \('pending', 'processing'\) then\s+return jsonb_build_object\('ok', true, 'domain_transitioned', false\);/)
  })

  it('30. complete_merchant_payout_provider_attempt only applies a reversal from the paid state, never any other', () => {
    const body = extractBody(sql, 'create or replace function public.complete_merchant_payout_provider_attempt(')
    expect(body).toMatch(/if p_provider_status = 'reversed' then\s+if v_payout\.status = 'paid' then/)
  })

  it('31. complete_merchant_payout_provider_attempt refuses to apply successful/failed/cancelled unless the domain row is still processing (stale-attempt protection)', () => {
    const body = extractBody(sql, 'create or replace function public.complete_merchant_payout_provider_attempt(')
    expect(body).toMatch(/if v_payout\.status <> 'processing' then\s+return jsonb_build_object\('ok', true, 'domain_transitioned', false\);/)
  })

  it("32. complete_merchant_payout_provider_attempt is the only new function that can ever transition a payout to 'paid'", () => {
    const otherBodies = [
      extractBody(sql, 'create or replace function public.start_merchant_payout_provider_attempt('),
      extractBody(sql, 'create or replace function public._merchant_payout_ledger_currency('),
      extractBody(sql, 'create or replace function public._payout_provider_attempts_has_active('),
    ]
    for (const body of otherBodies) {
      expect(body).not.toMatch(/'paid'/)
    }
    const completeBody = extractBody(sql, 'create or replace function public.complete_merchant_payout_provider_attempt(')
    expect(completeBody).toMatch(/v_payout\.id, 'paid', array\['processing'\]/)
  })

  it('33. complete_merchant_payout_provider_attempt preserves prior paid history on reversal -- never passes a new payout_reference/payout_method for the reversed transition', () => {
    const body = extractBody(sql, 'create or replace function public.complete_merchant_payout_provider_attempt(')
    const reversedCallIdx = body.indexOf("'reversed', array['paid']::payout_status[]")
    const chunk = body.slice(reversedCallIdx, reversedCallIdx + 300)
    expect(chunk).toMatch(/null, null, null, null, false, null/)
  })

  it('34. start_affiliate_payout_provider_attempt requires exactly ZAR currency directly from affiliate_commissions.currency', () => {
    const body = extractBody(sql, 'create or replace function public.start_affiliate_payout_provider_attempt(')
    expect(body).toMatch(/if v_commission\.currency <> 'ZAR' then/)
  })

  it('35. start_affiliate_payout_provider_attempt only starts from payout_queued', () => {
    const body = extractBody(sql, 'create or replace function public.start_affiliate_payout_provider_attempt(')
    expect(body).toMatch(/if v_commission\.status <> 'payout_queued' then/)
  })

  it('36. start_affiliate_payout_provider_attempt calls the same E32 destination eligibility RPC and bank-mapping check as the merchant path', () => {
    const body = extractBody(sql, 'create or replace function public.start_affiliate_payout_provider_attempt(')
    expect(body).toMatch(/public\._payout_destination_eligibility\(v_commission\.affiliate_id\)/)
    expect(body).toMatch(/pb\.peach_payout_bank_name into v_bank_name/)
  })

  it("37. start_affiliate_payout_provider_attempt uses the existing _affiliate_commission_transition helper (payout_queued -> processing), not a new status machine", () => {
    const body = extractBody(sql, 'create or replace function public.start_affiliate_payout_provider_attempt(')
    expect(body).toMatch(/_affiliate_commission_transition\(\s*p_commission_id, 'processing', array\['payout_queued'\]/)
  })

  it("38. complete_affiliate_payout_provider_attempt is the only new function that can ever transition a commission to 'paid', and sets payout_provider_reference/payout_confirmed_at only then", () => {
    const body = extractBody(sql, 'create or replace function public.complete_affiliate_payout_provider_attempt(')
    expect(body).toMatch(/payout_provider_reference = v_attempt\.provider_payout_id::text, payout_confirmed_at = now\(\)/)
    const startBody = extractBody(sql, 'create or replace function public.start_affiliate_payout_provider_attempt(')
    expect(startBody).not.toMatch(/'paid'/)
  })

  it('39. complete_affiliate_payout_provider_attempt only reverses from paid, mirroring the merchant path', () => {
    const body = extractBody(sql, 'create or replace function public.complete_affiliate_payout_provider_attempt(')
    expect(body).toMatch(/if p_provider_status = 'reversed' then\s+if v_commission\.status = 'paid' then/)
  })

  it('40. complete_affiliate_payout_provider_attempt is idempotent and out-of-order-safe, mirroring the merchant path exactly', () => {
    const body = extractBody(sql, 'create or replace function public.complete_affiliate_payout_provider_attempt(')
    expect(body).toMatch(/'duplicate', true/)
    expect(body).toMatch(/'ignored_out_of_order', true/)
  })

  it('41. mark_payout_paid gains the provider-attempt conflict guard, body otherwise preserving its existing safe-to-pay re-check', () => {
    const body = extractBody(sql, 'create or replace function public.mark_payout_paid(')
    expect(body).toMatch(/public\._payout_provider_attempts_has_active\(p_payout_id, null\)/)
    expect(body).toMatch(/public\._merchant_payout_still_safe_to_pay_block\(v_payout\)/)
  })

  it('42. mark_payout_failed gains the provider-attempt conflict guard, body otherwise preserving its existing category validation and safe failure-message derivation', () => {
    const body = extractBody(sql, 'create or replace function public.mark_payout_failed(')
    expect(body).toMatch(/public\._payout_provider_attempts_has_active\(p_payout_id, null\)/)
    expect(body).toMatch(/v_failure_message_safe := case p_failure_category/)
  })

  it('43. retry_payout gains the provider-attempt conflict guard (no blind retry after an ambiguous provider outcome), body otherwise preserving its full-eligibility re-check', () => {
    const body = extractBody(sql, 'create or replace function public.retry_payout(')
    expect(body).toMatch(/public\._payout_provider_attempts_has_active\(p_payout_id, null\)/)
    expect(body).toMatch(/public\._merchant_payout_full_eligibility_block\(v_payout\)/)
  })

  it('44. does not touch payment_webhook_events, the BANV tables, or any E32 table\'s own schema -- this phase adds provider-execution authority only', () => {
    expect(normalized).not.toMatch(/alter table public\.payment_webhook_events/)
    expect(normalized).not.toMatch(/alter table public\.payout_destinations\b(?! secrets)/)
    expect(normalized).not.toMatch(/alter table public\.payout_destination_verification_attempts/)
  })

  it('45. performs zero historical backfill -- no TOP-LEVEL (migration-time, outside any function body) UPDATE/INSERT touches existing merchant_payouts or affiliate_commissions rows; the UPDATE/no-INSERT statements that DO exist are all inside runtime function bodies (legitimate, called later per-row, never executed against history at migration-apply time)', () => {
    // Strip every function body (between "as $$" and "$$;") before
    // checking -- a backfill would be a bare top-level statement, not
    // code inside a function definition that only runs when a caller
    // later invokes it against one specific row.
    let topLevelOnly = sql
    for (;;) {
      const start = topLevelOnly.indexOf('as $$')
      if (start === -1) break
      const end = topLevelOnly.indexOf('$$;', start)
      topLevelOnly = topLevelOnly.slice(0, start) + topLevelOnly.slice(end + 3)
    }
    const topLevelNormalized = topLevelOnly
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .replace(/\s+/g, ' ')
      .trim()
    expect(topLevelNormalized).not.toMatch(/update public\.merchant_payouts set/)
    expect(topLevelNormalized).not.toMatch(/update public\.affiliate_commissions set/)
    expect(topLevelNormalized).not.toMatch(/insert into public\.merchant_payouts/)
    expect(topLevelNormalized).not.toMatch(/insert into public\.affiliate_commissions/)
  })

  it('46. does not define record_webhook_event / claim_webhook_event_processing / mark_webhook_event_processed / mark_webhook_event_error -- the existing provider-neutral webhook lease RPCs are reused unchanged for the new Peach Payouts webhook', () => {
    expect(normalized).not.toMatch(/create (or replace )?function public\.record_webhook_event/)
    expect(normalized).not.toMatch(/create (or replace )?function public\.claim_webhook_event_processing/)
    expect(normalized).not.toMatch(/create (or replace )?function public\.mark_webhook_event_processed/)
    expect(normalized).not.toMatch(/create (or replace )?function public\.mark_webhook_event_error/)
  })

  it('47. does not touch PeachPaymentsProvider capability wiring in SQL -- capability flags are set in TypeScript only', () => {
    expect(normalized).not.toMatch(/supportsCapability/)
  })
})
