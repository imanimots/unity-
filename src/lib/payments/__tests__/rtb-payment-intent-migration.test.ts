import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// DB-free regression guards over the raw migration SQL text -- same
// convention as webhook-inbox-migration.test.ts's own "Step 6/P5D-M1
// migration invariants" blocks. No database connection, no Supabase
// CLI: this only proves the migration SOURCE contains the invariants
// P5D-M2 requires, not that it has been applied anywhere.
const REPO_ROOT = join(__dirname, '../../../..')
const migrationPath = join(REPO_ROOT, 'supabase/migrations/20260925090000_redefine_rtb_payment_intent_with_installment_correlation.sql')
const sql = readFileSync(migrationPath, 'utf-8')

const OLD_SIGNATURE = 'create_rent_to_buy_payment_intent(uuid, uuid, uuid, text, numeric, text, text, text)'
const NEW_SIGNATURE = 'create_rent_to_buy_payment_intent(uuid, uuid, uuid, text, numeric, text, text, text, integer)'

function functionBody(): string {
  const marker = 'create or replace function public.create_rent_to_buy_payment_intent'
  const idx = sql.indexOf(marker)
  expect(idx, `expected to find "${marker}" in the migration`).toBeGreaterThanOrEqual(0)
  return sql.slice(idx).split('$$;')[0]
}

describe('P5D-M2 RTB installment correlation migration invariants (regression guards over the SQL text)', () => {
  it('1. the exact old 8-argument function signature is dropped', () => {
    expect(sql).toMatch(new RegExp(`drop function if exists public\\.${OLD_SIGNATURE.replace(/[()]/g, '\\$&')}`))
  })

  it('2. the DROP does not use CASCADE', () => {
    const dropLine = sql.split('\n').find((line) => line.trim().toLowerCase().startsWith('drop function'))
    expect(dropLine, 'expected to find the drop function line').toBeDefined()
    expect(dropLine!.toLowerCase()).not.toMatch(/cascade/)
  })

  it('3. exactly one corrected create_rent_to_buy_payment_intent definition exists in the migration', () => {
    const matches = sql.match(/create or replace function public\.create_rent_to_buy_payment_intent/g) ?? []
    expect(matches.length).toBe(1)
  })

  it('4. the corrected signature includes a typed p_installment_sequence integer parameter', () => {
    const signature = sql.slice(sql.indexOf('create or replace function public.create_rent_to_buy_payment_intent'), sql.indexOf('returns jsonb'))
    expect(signature).toMatch(/p_installment_sequence integer/)
  })

  it('5. p_installment_sequence has a rollout-compatible default (null) -- existing 8-argument callers keep working', () => {
    const signature = sql.slice(sql.indexOf('create or replace function public.create_rent_to_buy_payment_intent'), sql.indexOf('returns jsonb'))
    expect(signature).toMatch(/p_installment_sequence integer default null/)
  })

  it('6. an invalid (<= 0) sequence is rejected before any insert', () => {
    const fnBody = functionBody()
    const validationSection = fnBody.split('insert into public.payments')[0]
    expect(validationSection).toMatch(/if p_installment_sequence <= 0 then/)
    expect(validationSection).toMatch(/raise exception 'installment sequence must be a positive integer'/)
  })

  it('7. a sequence supplied for a non-installment payment_type is rejected, never silently stored', () => {
    const fnBody = functionBody()
    const validationSection = fnBody.split('insert into public.payments')[0]
    expect(validationSection).toMatch(/if p_payment_type <> 'rent_to_buy_installment' then/)
    expect(validationSection).toMatch(/raise exception 'installment sequence is only valid for rent_to_buy_installment payments'/)
  })

  it('8. no generic p_metadata jsonb caller-supplied parameter exists anywhere in the signature', () => {
    const signature = sql.slice(sql.indexOf('create or replace function public.create_rent_to_buy_payment_intent'), sql.indexOf('returns jsonb'))
    expect(signature).not.toMatch(/p_metadata/)
  })

  it('9. a fresh installment insert writes payments.metadata in the same INSERT statement that creates the row', () => {
    const fnBody = functionBody()
    const insertStatement = fnBody.split('insert into public.payments')[1].split(';')[0]
    expect(insertStatement).toMatch(/metadata/)
    expect(insertStatement).toMatch(/v_metadata/)
  })

  it('10. the metadata key is the exact, namespaced "rent_to_buy_installment_sequence" -- never the generic "sequence"', () => {
    const fnBody = functionBody()
    expect(fnBody).toMatch(/jsonb_build_object\('rent_to_buy_installment_sequence', p_installment_sequence\)/)
    expect(fnBody).not.toMatch(/jsonb_build_object\('sequence'/)
  })

  it('11. metadata is constructed server-side from a typed parameter, not passed through from a caller-supplied jsonb blob', () => {
    const fnBody = functionBody()
    const metadataAssignment = fnBody.split('v_metadata := ')[1].split(';')[0]
    expect(metadataAssignment).toMatch(/p_installment_sequence/)
    expect(metadataAssignment).not.toMatch(/p_metadata/)
  })

  it('12. p_installment_sequence is folded into v_request_hash -- a replay with the same idempotency key but a different sequence produces a different hash', () => {
    const fnBody = functionBody()
    const hashAssignment = fnBody.split('v_request_hash := md5(')[1].split(');')[0]
    expect(hashAssignment).toMatch(/p_installment_sequence/)
  })

  it('13. a conflicting existing correlation (same idempotency key, different hash) cannot be silently accepted -- the existing conflict-detection exception is preserved unmodified', () => {
    const fnBody = functionBody()
    expect(fnBody).toMatch(/if v_idem\.request_hash is distinct from v_request_hash then/)
    expect(fnBody).toMatch(/raise exception 'idempotency key already used with a different request'/)
  })

  it('14. no backfill/UPDATE statement against payments.metadata exists anywhere in this migration -- correlation is written exactly once, at insert time', () => {
    expect(sql).not.toMatch(/update public\.payments set/)
  })

  it('15. no sequence value is ever parsed from the idempotency-key string', () => {
    const fnBody = functionBody()
    expect(fnBody).not.toMatch(/split_part\(p_idempotency_key/)
    expect(fnBody).not.toMatch(/substring\(p_idempotency_key/)
  })

  it('16. rent_to_buy_installments.payment_id is never referenced or updated by the actual function body (the header comment discusses, but never acts on, that rejected alternative)', () => {
    const fnBody = functionBody()
    expect(fnBody).not.toMatch(/rent_to_buy_installments/)
  })

  it('17. no new table, column, index, or constraint is created -- this is an RPC redefinition only', () => {
    expect(sql).not.toMatch(/create table/i)
    expect(sql).not.toMatch(/add column/i)
    expect(sql).not.toMatch(/create index/i)
    expect(sql).not.toMatch(/create.*constraint|add constraint/i)
    expect(sql).not.toMatch(/create type|alter type/i)
  })

  it('18. the return contract is unchanged -- still exactly {payment_id: ...}', () => {
    const fnBody = functionBody()
    const resultAssignments = fnBody.match(/v_result := jsonb_build_object\([^)]*\)/g) ?? []
    expect(resultAssignments.length).toBeGreaterThan(0)
    for (const assignment of resultAssignments) {
      expect(assignment).toMatch(/'payment_id', v_payment_id/)
      expect(assignment).not.toMatch(/rent_to_buy_installment_sequence/)
    }
  })

  it('19. SECURITY DEFINER, search_path, and the service_role auth guard are preserved', () => {
    const fnBody = functionBody()
    expect(fnBody).toMatch(/security definer/)
    expect(fnBody).toMatch(/set search_path = public/)
    expect(fnBody).toMatch(/if auth\.role\(\) <> 'service_role' then/)
  })

  it('20. grants/revokes reference only the corrected 9-argument signature', () => {
    const escaped = NEW_SIGNATURE.replace(/[()]/g, '\\$&')
    expect(sql).toMatch(new RegExp(`revoke all on function public\\.${escaped} from public, anon, authenticated`))
    expect(sql).toMatch(new RegExp(`grant execute on function public\\.${escaped} to service_role`))
  })

  it('21. no grant/revoke references the obsolete 8-argument signature', () => {
    const escapedOld = OLD_SIGNATURE.replace(/[()]/g, '\\$&')
    expect(sql).not.toMatch(new RegExp(`grant execute on function public\\.${escapedOld}`))
    expect(sql).not.toMatch(new RegExp(`revoke all on function public\\.${escapedOld} from`))
  })

  it('22. no refund, provider-reference-index, or webhook-inbox work is included -- this migration is scoped to RTB correlation only', () => {
    expect(sql).not.toMatch(/payments_provider_reference_unique/)
    expect(sql).not.toMatch(/create.*function.*refund/i)
    expect(sql).not.toMatch(/payment_webhook_events/)
    expect(sql).not.toMatch(/claim_webhook_event_processing|mark_webhook_event_processed|mark_webhook_event_error/)
  })
})
