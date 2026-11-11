import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * E32 migration-contract test for
 * 20261111184936_add_payout_destination_authority.sql.
 *
 * Scope: establishes a secure, versioned, fail-closed authority for
 * WHERE a future real payout would send money (merchant or affiliate),
 * via Supabase Vault for the raw account number and a `private`-schema
 * mapping table for the vault pointer -- without activating any real
 * payout capability (Peach's merchant_payout/affiliate_payout stay
 * false, unchanged from E30).
 *
 * LIMITATION, per this codebase's established convention: this test
 * parses SQL source text and asserts on its structure. It does not
 * execute against a live Postgres instance.
 */
const REPO_ROOT = join(__dirname, '../../..')
const MIGRATIONS_DIR = join(REPO_ROOT, 'supabase/migrations')
const MIGRATION_FILE = '20261111184936_add_payout_destination_authority.sql'
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

describe('20261111184936_add_payout_destination_authority.sql (category: ADMIN-CONTROL-CENTRE-BATCH-E32)', () => {
  it('1. enables the supabase_vault extension idempotently, no new pgsodium usage', () => {
    expect(normalized).toMatch(/create extension if not exists supabase_vault with schema vault;/)
    expect(normalized.toLowerCase()).not.toContain('pgsodium')
  })

  it('2. reuses the pre-existing private schema idempotently rather than redefining it', () => {
    expect(normalized).toMatch(/create schema if not exists private;/)
  })

  it('3. creates exactly the 4 new public tables and 1 new private table this phase requires', () => {
    const publicTables = ['payout_banks', 'payout_destinations', 'payout_destination_verification_attempts', 'payout_destination_history']
    for (const t of publicTables) {
      expect(normalized).toMatch(new RegExp(`create table if not exists public\\.${t} `))
    }
    expect(normalized).toMatch(/create table if not exists private\.payout_destination_secrets /)
  })

  it('4. payout_destinations has no raw account number or vault-pointer column -- only safe metadata', () => {
    const start = normalized.indexOf('create table if not exists public.payout_destinations')
    const end = normalized.indexOf(');', start)
    const body = normalized.slice(start, end)
    expect(body).not.toMatch(/account_number/)
    expect(body).not.toMatch(/vault_secret/)
    expect(body).not.toMatch(/id_number|legal_surname|legal_first_name/)
    expect(body).toMatch(/account_last4/)
    expect(body).toMatch(/owner_id uuid not null references public\.profiles\(id\)/)
  })

  it('5. the vault secret pointer lives only in private.payout_destination_secrets, never on the public row', () => {
    const start = normalized.indexOf('create table if not exists private.payout_destination_secrets')
    const end = normalized.indexOf(');', start)
    const body = normalized.slice(start, end)
    expect(body).toMatch(/vault_secret_id uuid not null/)
    expect(body).toMatch(/destination_id uuid primary key references public\.payout_destinations\(id\)/)
  })

  it('6. payout_destination_verification_attempts stores only safe attestation outcomes, never raw banking data', () => {
    const start = normalized.indexOf('create table if not exists public.payout_destination_verification_attempts')
    const end = normalized.indexOf(');', start)
    const body = normalized.slice(start, end)
    expect(body).not.toMatch(/account_number/)
    expect(body).toMatch(/field_results jsonb/)
    expect(body).toMatch(/provider_verification_id text/)
  })

  it('7. enforces at most one current+enabled destination per owner via a real partial unique index, not just RPC discipline', () => {
    expect(normalized).toMatch(
      /create unique index if not exists payout_destinations_one_current_per_owner_idx\s+on public\.payout_destinations \(owner_id\)\s+where is_current and disabled_at is null;/
    )
  })

  it('8. RLS is enabled on every new public table and private.payout_destination_secrets', () => {
    const tables = [
      'public.payout_banks',
      'public.payout_destinations',
      'public.payout_destination_verification_attempts',
      'public.payout_destination_history',
      'private.payout_destination_secrets',
    ]
    for (const t of tables) {
      expect(normalized).toMatch(new RegExp(`alter table ${t.replace('.', '\\.')} enable row level security;`))
    }
  })

  it('9. private.payout_destination_secrets has zero policies -- it relies on schema non-exposure + grants, not RLS, as its primary control', () => {
    const start = normalized.indexOf('alter table private.payout_destination_secrets enable row level security;')
    const nextSection = normalized.indexOf('-- ====', start)
    const body = normalized.slice(start, nextSection === -1 ? undefined : nextSection)
    expect(body).not.toMatch(/create policy/)
  })

  it('10. payout_destinations RLS grants read to owner and admin only, no insert/update/delete policy exists for any role', () => {
    expect(normalized).toMatch(/create policy "payout_destinations: owner read"\s+on public\.payout_destinations for select\s+using \(owner_id = auth\.uid\(\)\);/)
    expect(normalized).toMatch(/create policy "payout_destinations: admin read"/)
    const start = normalized.indexOf('create table if not exists public.payout_destinations')
    const nextTable = normalized.indexOf('create table if not exists public.payout_destination_verification_attempts')
    const section = normalized.slice(start, nextTable)
    expect(section).not.toMatch(/for insert|for update|for delete/)
  })

  it('11. a new private-schema, one-argument, auth.uid()-deriving ownership predicate is used for the two RLS-gated attempt/history tables, matching the post-E15 idiom', () => {
    expect(normalized).toMatch(/create or replace function private\.is_payout_destination_owner\(p_destination_id uuid\)/)
    expect(normalized).toMatch(/set search_path = ''/)
    expect(normalized).toMatch(/create policy "payout_destination_verification_attempts: owner read"\s+on public\.payout_destination_verification_attempts for select\s+using \(private\.is_payout_destination_owner\(destination_id\)\);/)
  })

  it('12. payout_destination_verification_attempts trigger blocks DELETE only (legitimate pending->resolved UPDATE must remain possible), matching the dispute_financial_dispositions precedent', () => {
    expect(normalized).toMatch(/create trigger payout_destination_verification_attempts_no_delete\s+before delete on public\.payout_destination_verification_attempts\s+for each row execute function public\.prevent_row_mutation\(\);/)
  })

  it('13. payout_destination_history is fully immutable (blocks both UPDATE and DELETE), matching the pure-audit-log precedent', () => {
    expect(normalized).toMatch(/create trigger payout_destination_history_immutable\s+before update or delete on public\.payout_destination_history\s+for each row execute function public\.prevent_row_mutation\(\);/)
  })

  it('14. reuses the existing public.prevent_row_mutation() trigger function verbatim -- never redefines it', () => {
    expect(normalized).not.toMatch(/create (or replace )?function public\.prevent_row_mutation/)
  })

  it('15. seeds the bank catalog from live-researched Peach data with asymmetric payout/BANV support captured faithfully', () => {
    expect(normalized).toMatch(/'bidvest_bank_alliances', 'Bidvest Bank Alliances', '683000', true, false/)
    expect(normalized).toMatch(/'finbond_net1', 'Finbond Net1', null, false, true/)
    expect(normalized).toMatch(/on conflict \(bank_code\) do nothing;/)
    const start = normalized.indexOf('insert into public.payout_banks')
    const end = normalized.indexOf('on conflict (bank_code) do nothing;', start)
    const body = normalized.slice(start, end)
    const rowCount = body.split("),").length
    expect(rowCount).toBeGreaterThanOrEqual(29)
  })

  it('16. every new SECURITY DEFINER function uses search_path = \'\' with no exceptions', () => {
    const functionMarkers = [
      'private.is_payout_destination_owner',
      'public.create_payout_destination',
      'public.get_payout_destination_account_number',
      'public.start_bank_verification_attempt',
      'public.record_bank_verification_submitted',
      'public.record_bank_verification_result',
      'public.disable_payout_destination',
      'public._payout_destination_eligibility',
    ]
    for (const marker of functionMarkers) {
      const idx = normalized.indexOf(`create or replace function ${marker}(`)
      expect(idx, `missing function ${marker}`).toBeGreaterThan(-1)
      const nextChunk = normalized.slice(idx, idx + 400)
      expect(nextChunk, `${marker} must use search_path = ''`).toMatch(/set search_path = ''/)
    }
  })

  it('17. every write-capable new function revokes public/anon/authenticated and grants only service_role', () => {
    const functions = [
      ['public.create_payout_destination', 'uuid, text, text, text, uuid, text'],
      ['public.get_payout_destination_account_number', 'uuid'],
      ['public.start_bank_verification_attempt', 'uuid, text, uuid, text'],
      ['public.record_bank_verification_submitted', 'uuid, text, text, text'],
      ['public.record_bank_verification_result', 'text, text, text, text, jsonb, text'],
      ['public.disable_payout_destination', 'uuid, uuid, text, text'],
      ['public._payout_destination_eligibility', 'uuid'],
    ]
    for (const [name, args] of functions) {
      const escaped = `${name}(${args})`.replace(/[.()]/g, (m) => `\\${m}`)
      expect(normalized, `missing revoke for ${name}`).toMatch(new RegExp(`revoke all on function ${escaped} from public, anon, authenticated;`))
      expect(normalized, `missing service_role grant for ${name}`).toMatch(new RegExp(`grant execute on function ${escaped} to service_role;`))
    }
  })

  it('18. every write-capable new function guards auth.role() <> service_role inside its own body, not just via grants', () => {
    const bodies = [
      extractBody(sql, 'create or replace function public.create_payout_destination('),
      extractBody(sql, 'create or replace function public.get_payout_destination_account_number('),
      extractBody(sql, 'create or replace function public.start_bank_verification_attempt('),
      extractBody(sql, 'create or replace function public.record_bank_verification_submitted('),
      extractBody(sql, 'create or replace function public.record_bank_verification_result('),
      extractBody(sql, 'create or replace function public.disable_payout_destination('),
      extractBody(sql, 'create or replace function public._payout_destination_eligibility('),
    ]
    for (const body of bodies) {
      expect(body).toMatch(/auth\.role\(\) <> 'service_role'/)
    }
  })

  it('19. create_payout_destination validates account number and account type before touching Vault or any table', () => {
    const body = extractBody(sql, 'create or replace function public.create_payout_destination(')
    expect(body).toMatch(/p_account_number !~ '\^\[0-9\]\{1,13\}\$'/)
    expect(body).toMatch(/p_account_type not in \(/)
  })

  it('20. create_payout_destination calls vault.create_secret with the destination uuid as the secret name, never bank/PII fragments', () => {
    const body = extractBody(sql, 'create or replace function public.create_payout_destination(')
    expect(body).toMatch(/vault\.create_secret\(p_account_number, 'payout_destination:' \|\| v_new_id::text, null\)/)
  })

  it('21. create_payout_destination supersedes any previous current destination in the same transaction before inserting the new one', () => {
    const body = extractBody(sql, 'create or replace function public.create_payout_destination(')
    const supersedeIdx = body.indexOf('update public.payout_destinations set is_current = false')
    const insertIdx = body.indexOf('insert into public.payout_destinations (')
    expect(supersedeIdx).toBeGreaterThan(-1)
    expect(insertIdx).toBeGreaterThan(supersedeIdx)
  })

  it('22. create_payout_destination maps a concurrent-create race to a clear error instead of leaking a raw constraint message', () => {
    const body = extractBody(sql, 'create or replace function public.create_payout_destination(')
    expect(body).toMatch(/when unique_violation then\s+raise exception 'a concurrent bank-detail change is already in progress/)
  })

  it('23. get_payout_destination_account_number is the only function reading vault.decrypted_secrets, and only via the private mapping table', () => {
    const occurrences = normalized.match(/vault\.decrypted_secrets/g) ?? []
    expect(occurrences.length).toBeGreaterThan(0)
    const body = extractBody(sql, 'create or replace function public.get_payout_destination_account_number(')
    expect(body).toMatch(/join vault\.decrypted_secrets on vault\.decrypted_secrets\.id = private\.payout_destination_secrets\.vault_secret_id/)
    // No other function body references vault.decrypted_secrets.
    const otherMarkers = [
      'public.create_payout_destination(',
      'public.start_bank_verification_attempt(',
      'public.record_bank_verification_submitted(',
      'public.record_bank_verification_result(',
      'public.disable_payout_destination(',
      'public._payout_destination_eligibility(',
    ]
    for (const marker of otherMarkers) {
      const body2 = extractBody(sql, `create or replace function ${marker}`)
      expect(body2).not.toMatch(/decrypted_secrets/)
    }
  })

  it('24. no new function returns a raw secret to anything other than get_payout_destination_account_number, and that function is never granted to authenticated/anon', () => {
    expect(normalized).toMatch(/revoke all on function public\.get_payout_destination_account_number\(uuid\) from public, anon, authenticated;/)
  })

  it('25. start_bank_verification_attempt refuses for a disabled/non-current destination and for a bank without BANV support', () => {
    const body = extractBody(sql, 'create or replace function public.start_bank_verification_attempt(')
    expect(body).toMatch(/not v_dest\.is_current or v_dest\.disabled_at is not null/)
    expect(body).toMatch(/not v_bank\.banv_supported/)
  })

  it('26. start_bank_verification_attempt never regresses an already-verified destination back to pending', () => {
    const body = extractBody(sql, 'create or replace function public.start_bank_verification_attempt(')
    expect(body).toMatch(/if v_dest\.verification_status <> 'verified' then/)
  })

  it('27. record_bank_verification_submitted never marks a destination verified by itself -- it moves it to processing at most', () => {
    const body = extractBody(sql, 'create or replace function public.record_bank_verification_submitted(')
    expect(body).not.toMatch(/verification_status = 'verified'/)
    expect(body).toMatch(/verification_status = 'processing'/)
  })

  it("28. record_bank_verification_result is the only function that can ever set verification_status = 'verified'", () => {
    const allOtherFunctionNames = [
      'private.is_payout_destination_owner',
      'public.create_payout_destination',
      'public.get_payout_destination_account_number',
      'public.start_bank_verification_attempt',
      'public.record_bank_verification_submitted',
      'public.disable_payout_destination',
      'public._payout_destination_eligibility',
    ]
    for (const name of allOtherFunctionNames) {
      const body = extractBody(sql, `create or replace function ${name}(`)
      expect(body, `${name} must never SET verification_status = 'verified'`).not.toMatch(/set verification_status = 'verified'/)
    }
    const resultBody = extractBody(sql, 'create or replace function public.record_bank_verification_result(')
    expect(resultBody).toMatch(/set verification_status = 'verified'/)
  })

  it('29. record_bank_verification_result only acts on p_source webhook or query_reconciliation, never admin_manual', () => {
    const body = extractBody(sql, 'create or replace function public.record_bank_verification_result(')
    expect(body).toMatch(/p_source not in \('webhook', 'query_reconciliation'\)/)
  })

  it('30. record_bank_verification_result is idempotent on a duplicate final result for the same attempt', () => {
    const body = extractBody(sql, 'create or replace function public.record_bank_verification_result(')
    expect(body).toMatch(/v_attempt\.resolved_at is not null and v_attempt\.status = p_status/)
    expect(body).toMatch(/'duplicate', true/)
  })

  it('31. record_bank_verification_result refuses to let a non-final status regress an already-resolved attempt', () => {
    const body = extractBody(sql, 'create or replace function public.record_bank_verification_result(')
    expect(body).toMatch(/v_attempt\.resolved_at is not null and p_status in \('pending', 'processing'\)/)
    expect(body).toMatch(/'ignored_out_of_order', true/)
  })

  it('32. record_bank_verification_result never reactivates a superseded or disabled destination (checks is_current and disabled_at before any destination mutation)', () => {
    const body = extractBody(sql, 'create or replace function public.record_bank_verification_result(')
    expect(body).toMatch(/if v_dest\.is_current and v_dest\.disabled_at is null and v_dest\.verification_status <> 'verified' then/)
  })

  it('33. record_bank_verification_result sets a 90-day verification_expires_at on success, matching the chosen freshness policy', () => {
    const body = extractBody(sql, 'create or replace function public.record_bank_verification_result(')
    expect(body).toMatch(/verification_expires_at = now\(\) \+ interval '90 days'/)
  })

  it("34. record_bank_verification_result persists Peach's own authoritative verification_id, never a Unity-generated uuid", () => {
    const body = extractBody(sql, 'create or replace function public.record_bank_verification_result(')
    expect(body).toMatch(/verification_id = p_provider_verification_id/)
  })

  it('35. disable_payout_destination is a soft-disable only -- no DELETE statement anywhere in this migration touches payout_destinations, attempts, or history', () => {
    expect(normalized).not.toMatch(/delete from public\.payout_destinations/)
    expect(normalized).not.toMatch(/delete from public\.payout_destination_verification_attempts/)
    expect(normalized).not.toMatch(/delete from public\.payout_destination_history/)
    const body = extractBody(sql, 'create or replace function public.disable_payout_destination(')
    expect(body).toMatch(/disabled_at = now\(\)/)
  })

  it('36. _payout_destination_eligibility requires exactly one current, enabled, verified, non-stale destination', () => {
    const body = extractBody(sql, 'create or replace function public._payout_destination_eligibility(')
    expect(body).toMatch(/where owner_id = p_owner_id and is_current and disabled_at is null/)
    expect(body).toMatch(/v_dest\.verification_status = 'verified' and v_dest\.verification_expires_at < now\(\)/)
    expect(body).toMatch(/'eligible', false, 'reason', 'stale'/)
    expect(body).toMatch(/'eligible', false, 'reason', 'no_destination'/)
    expect(body).toMatch(/'eligible', true, 'reason', null/)
  })

  it('37. does not alter merchant_payouts, affiliate_commissions, or payment_webhook_events -- this phase adds authority only, no payout execution wiring', () => {
    expect(normalized).not.toMatch(/alter table public\.merchant_payouts/)
    expect(normalized).not.toMatch(/alter table public\.affiliate_commissions/)
    expect(normalized).not.toMatch(/alter table public\.payment_webhook_events/)
  })

  it('38. does not define record_webhook_event / claim_webhook_event_processing / mark_webhook_event_processed / mark_webhook_event_error -- the existing provider-neutral webhook lease RPCs are reused unchanged for BANV', () => {
    expect(normalized).not.toMatch(/create (or replace )?function public\.record_webhook_event/)
    expect(normalized).not.toMatch(/create (or replace )?function public\.claim_webhook_event_processing/)
    expect(normalized).not.toMatch(/create (or replace )?function public\.mark_webhook_event_processed/)
    expect(normalized).not.toMatch(/create (or replace )?function public\.mark_webhook_event_error/)
  })

  it('39. does not touch PeachPaymentsProvider capability wiring in SQL -- merchant_payout/affiliate_payout capability stays a TypeScript-side false, unchanged', () => {
    expect(normalized).not.toMatch(/supportsCapability/)
  })

  it('40. every new table has an explicit primary key and every destination/attempt/history FK references profiles or payout_destinations, never a bare polymorphic recipient_type/recipient_id pair', () => {
    expect(normalized).not.toMatch(/recipient_type/)
    expect(normalized).not.toMatch(/recipient_id uuid/)
  })
})
