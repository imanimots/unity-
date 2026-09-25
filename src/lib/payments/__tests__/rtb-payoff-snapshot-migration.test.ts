import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// DB-free regression guards over the raw migration SQL text -- same
// convention as rtb-payment-intent-migration.test.ts's own invariant
// blocks. No database connection, no Supabase CLI: this only proves the
// migration SOURCE contains the invariants P5D-M3 requires, not that it
// has been applied anywhere.
const REPO_ROOT = join(__dirname, '../../../..')
const migrationPath = join(REPO_ROOT, 'supabase/migrations/20260926090000_harden_rtb_payoff_snapshot_and_completion.sql')
const sql = readFileSync(migrationPath, 'utf-8')

const OLD_INTENT_SIGNATURE = 'create_rent_to_buy_payment_intent(uuid, uuid, uuid, text, numeric, text, text, text, integer)'
const NEW_INTENT_SIGNATURE = 'create_rent_to_buy_payment_intent(uuid, uuid, uuid, text, numeric, text, text, text, integer, integer[])'
const PAYOFF_SIGNATURE = 'payoff_rent_to_buy_agreement(uuid, uuid, uuid, text)'

function functionBody(functionName: string): string {
  const marker = `create or replace function public.${functionName}`
  const idx = sql.indexOf(marker)
  expect(idx, `expected to find "${marker}" in the migration`).toBeGreaterThanOrEqual(0)
  const nextIdx = sql.indexOf(marker, idx + 1)
  expect(nextIdx, `expected exactly one definition of ${functionName}`).toBe(-1)
  return sql.slice(idx).split('$$;')[0]
}

const intentBody = () => functionBody('create_rent_to_buy_payment_intent')
const payoffBody = () => functionBody('payoff_rent_to_buy_agreement')

describe('P5D-M3 create_rent_to_buy_payment_intent invariants (SQL text)', () => {
  it('1. the exact P5D-M2 9-argument signature is dropped', () => {
    expect(sql).toMatch(new RegExp(`drop function if exists public\\.${OLD_INTENT_SIGNATURE.replace(/[()[\]]/g, '\\$&')}`))
  })

  it('2. the DROP does not use CASCADE', () => {
    const dropLine = sql.split('\n').find((line) => line.trim().toLowerCase().startsWith('drop function if exists public.create_rent_to_buy_payment_intent'))
    expect(dropLine, 'expected to find the create_rent_to_buy_payment_intent drop line').toBeDefined()
    expect(dropLine!.toLowerCase()).not.toMatch(/cascade/)
  })

  it('3. the corrected signature includes a typed p_payoff_sequences integer[] default null parameter', () => {
    const signature = sql.slice(sql.indexOf('create or replace function public.create_rent_to_buy_payment_intent'), sql.indexOf('returns jsonb'))
    expect(signature).toMatch(/p_payoff_sequences integer\[\] default null/)
  })

  it('4. no generic p_metadata jsonb caller-supplied parameter exists anywhere in the signature', () => {
    const signature = sql.slice(sql.indexOf('create or replace function public.create_rent_to_buy_payment_intent'), sql.indexOf('returns jsonb'))
    expect(signature).not.toMatch(/p_metadata/)
  })

  it('5. the supplied array is canonicalized via sort, not accepted as-is', () => {
    expect(intentBody()).toMatch(/array_agg\(distinct s order by s\)/)
  })

  it('6. an empty payoff array is rejected', () => {
    const body = intentBody()
    expect(body).toMatch(/if array_length\(p_payoff_sequences, 1\) is null then/)
    expect(body).toMatch(/raise exception 'payoff sequence set must not be empty'/)
  })

  it('7. NULL elements in the payoff array are rejected', () => {
    const body = intentBody()
    expect(body).toMatch(/where s is null/)
    expect(body).toMatch(/raise exception 'payoff sequence set must not contain null elements'/)
  })

  it('8. zero and negative elements in the payoff array are rejected', () => {
    const body = intentBody()
    expect(body).toMatch(/where s <= 0/)
    expect(body).toMatch(/raise exception 'payoff sequence set must contain only positive integers'/)
  })

  it('9. duplicate sequence values are rejected, never silently de-duplicated', () => {
    const body = intentBody()
    expect(body).toMatch(/if v_supplied_count <> array_length\(v_canonical_payoff, 1\) then/)
    expect(body).toMatch(/raise exception 'payoff sequence set must not contain duplicate sequence values'/)
  })

  it('10. supplying both a single installment sequence and a payoff set is rejected', () => {
    const body = intentBody()
    expect(body).toMatch(/if p_installment_sequence is not null and p_payoff_sequences is not null then/)
    expect(body).toMatch(/raise exception 'a payment cannot carry both a single installment sequence and a payoff sequence set'/)
  })

  it('11. neither correlation field is valid for a non-installment (deposit) payment type', () => {
    const body = intentBody()
    expect(body).toMatch(/raise exception 'installment sequence is only valid for rent_to_buy_installment payments'/)
    expect(body).toMatch(/raise exception 'payoff sequence set is only valid for rent_to_buy_installment payments'/)
  })

  it('12. payoff sequences are validated against the exact target agreement', () => {
    const body = intentBody()
    const lookup = body.slice(body.indexOf('from public.rent_to_buy_installments'), body.indexOf('from public.rent_to_buy_installments') + 200)
    expect(lookup).toMatch(/agreement_id = p_rent_to_buy_agreement_id/)
  })

  it('13. payoff sequences must currently be scheduled (eligible) at snapshot time', () => {
    const body = intentBody()
    const lookup = body.slice(body.indexOf('from public.rent_to_buy_installments'), body.indexOf('from public.rent_to_buy_installments') + 200)
    expect(lookup).toMatch(/status = 'scheduled'/)
  })

  it('14. the exact payoff amount is bound to the snapshot sum -- a mismatch is rejected before any insert', () => {
    const body = intentBody()
    const validationSection = body.split('insert into public.payments')[0]
    expect(validationSection).toMatch(/if p_amount is distinct from v_payoff_sum then/)
    expect(validationSection).toMatch(/raise exception 'payoff amount must equal the exact sum of the snapshotted installment principal amounts'/)
  })

  it('15. the canonical payoff array is folded into v_request_hash', () => {
    const body = intentBody()
    const hashAssignment = body.split('v_request_hash := md5(')[1].split(');')[0]
    expect(hashAssignment).toMatch(/v_canonical_payoff/)
  })

  it('16. the hash uses the canonical (sorted, deduplicated) array, not the raw caller-supplied order', () => {
    const body = intentBody()
    const hashAssignment = body.split('v_request_hash := md5(')[1].split(');')[0]
    expect(hashAssignment).toMatch(/array_to_string\(v_canonical_payoff, ','\)/)
    expect(hashAssignment).not.toMatch(/p_payoff_sequences/)
  })

  it('17. the metadata key is the exact, namespaced "rent_to_buy_payoff_sequences"', () => {
    expect(intentBody()).toMatch(/jsonb_build_object\('rent_to_buy_payoff_sequences', to_jsonb\(v_canonical_payoff\)\)/)
  })

  it('18. the payoff metadata value is a native numeric array, not a string or nested object', () => {
    const body = intentBody()
    expect(body).toMatch(/to_jsonb\(v_canonical_payoff\)/)
    expect(body).not.toMatch(/rent_to_buy_payoff_sequences::text/)
  })

  it('19. rent_to_buy_installments.payment_id is never pre-linked by this function', () => {
    const body = intentBody()
    expect(body).not.toMatch(/update public\.rent_to_buy_installments/)
  })

  it('20. no provider-metadata dependency and no idempotency-key string parsing', () => {
    const body = intentBody()
    expect(body).not.toMatch(/split_part\(p_idempotency_key/)
    expect(body).not.toMatch(/substring\(p_idempotency_key/)
  })

  it('21. legacy callers supplying neither correlation field remain possible (both parameters default null, no "at least one required" guard)', () => {
    const signature = sql.slice(sql.indexOf('create or replace function public.create_rent_to_buy_payment_intent'), sql.indexOf('returns jsonb'))
    expect(signature).toMatch(/p_installment_sequence integer default null/)
    expect(signature).toMatch(/p_payoff_sequences integer\[\] default null/)
    const body = intentBody()
    expect(body).not.toMatch(/at least one of/)
  })

  it('22. grants/revokes reference only the corrected 10-argument signature', () => {
    const escaped = NEW_INTENT_SIGNATURE.replace(/[()[\]]/g, '\\$&')
    expect(sql).toMatch(new RegExp(`revoke all on function public\\.${escaped} from public, anon, authenticated`))
    expect(sql).toMatch(new RegExp(`grant execute on function public\\.${escaped} to service_role`))
  })

  it('23. no grant/revoke references the obsolete 9-argument signature, and exactly one create_rent_to_buy_payment_intent definition exists', () => {
    const escapedOld = OLD_INTENT_SIGNATURE.replace(/[()[\]]/g, '\\$&')
    expect(sql).not.toMatch(new RegExp(`grant execute on function public\\.${escapedOld}`))
    expect(sql).not.toMatch(new RegExp(`revoke all on function public\\.${escapedOld} from`))
    const matches = sql.match(/create or replace function public\.create_rent_to_buy_payment_intent/g) ?? []
    expect(matches.length).toBe(1)
  })
})

describe('P5D-M3 payoff_rent_to_buy_agreement invariants (SQL text)', () => {
  it('1. the payment row is loaded by p_payment_id', () => {
    expect(payoffBody()).toMatch(/select \* into v_payment from public\.payments where id = p_payment_id/)
  })

  it('2. the payment must belong to the target agreement', () => {
    const body = payoffBody()
    expect(body).toMatch(/if v_payment\.rent_to_buy_agreement_id is distinct from p_agreement_id then/)
    expect(body).toMatch(/raise exception 'payment does not belong to this agreement'/)
  })

  it('3. the payment_type must be rent_to_buy_installment', () => {
    const body = payoffBody()
    expect(body).toMatch(/if v_payment\.payment_type <> 'rent_to_buy_installment' then/)
  })

  it('4. the payment must be captured before completion is attempted', () => {
    const body = payoffBody()
    expect(body).toMatch(/if v_payment\.status <> 'captured' then/)
    expect(body).toMatch(/raise exception 'payment has not been captured'/)
  })

  it('5. the payoff snapshot is read from payment.metadata, never from caller input', () => {
    const body = payoffBody()
    expect(body).toMatch(/v_payment\.metadata -> 'rent_to_buy_payoff_sequences'/)
    expect(body).not.toMatch(/p_payoff_sequences/)
  })

  it('6. a missing snapshot resolves to invalid_snapshot, never a fallback to "current unpaid" installments', () => {
    const body = payoffBody()
    expect(body).toMatch(/if not \(v_payment\.metadata \? 'rent_to_buy_payoff_sequences'\) then/)
    expect(body).toMatch(/'status', 'invalid_snapshot'/)
    expect(body).not.toMatch(/where agreement_id = p_agreement_id and status = 'scheduled'/)
  })

  it('7. exact snapshot cardinality is checked -- a sequence that no longer exists is detected, not silently dropped', () => {
    const body = payoffBody()
    expect(body).toMatch(/if v_matched_count <> v_snapshot_count then/)
  })

  it('8. the snapshot principal total is checked against payments.amount, not a recalculated moving balance', () => {
    const body = payoffBody()
    expect(body).toMatch(/if v_payment\.amount is distinct from v_snapshot_sum then/)
  })

  it('9. the agreement row is locked FOR UPDATE before any classification or write', () => {
    const body = payoffBody()
    expect(body).toMatch(/select \* into v_agreement from public\.rent_to_buy_agreements where id = p_agreement_id for update/)
  })

  it('10. snapshot rows already paid by the SAME payment are classified separately from unpaid rows', () => {
    const body = payoffBody()
    expect(body).toMatch(/count\(\*\) filter \(where status = 'paid' and payment_id = p_payment_id\)/)
  })

  it('11. a retry after successful completion returns a structured already_completed result, not an exception', () => {
    const body = payoffBody()
    expect(body).toMatch(/'status', 'already_completed'/)
  })

  it('12. an already-completed agreement is still eligible for the SAME payment\'s idempotent retry (status guard allows completed through)', () => {
    const body = payoffBody()
    expect(body).toMatch(/if v_agreement\.status not in \('active', 'completed'\) then/)
  })

  it('13. a different-payment conflict is detected before any installment write', () => {
    const body = payoffBody()
    const conflictIdx = body.indexOf("'status', 'payment_conflict'")
    const updateIdx = body.indexOf('update public.rent_to_buy_installments set status')
    expect(conflictIdx).toBeGreaterThan(-1)
    expect(updateIdx).toBeGreaterThan(-1)
    expect(conflictIdx).toBeLessThan(updateIdx)
  })

  it('14. a conflict result precedes and blocks any payment_id write', () => {
    const body = payoffBody()
    const conflictIdx = body.indexOf("'status', 'payment_conflict'")
    const updateIdx = body.indexOf('update public.rent_to_buy_installments set status')
    expect(conflictIdx).toBeLessThan(updateIdx)
  })

  it('15. a conflict result precedes and blocks any ownership transfer', () => {
    const body = payoffBody()
    const conflictIdx = body.indexOf("'status', 'payment_conflict'")
    const ownershipIdx = body.indexOf('update public.rent_to_buy_agreements')
    expect(conflictIdx).toBeLessThan(ownershipIdx)
  })

  it('16. only the exact snapshotted, still-scheduled rows are ever updated -- no broad agreement-wide predicate', () => {
    const body = payoffBody()
    expect(body).toMatch(/where agreement_id = p_agreement_id and sequence = any\(v_snapshot\) and status = 'scheduled'/)
    expect(body).not.toMatch(/update public\.rent_to_buy_installments set status = 'paid', payment_id = p_payment_id, paid_at = now\(\)\s*\n\s*where agreement_id = p_agreement_id and status = 'scheduled';/)
  })

  it('17. the update predicate is scoped by the snapshot array, not the whole agreement\'s scheduled set', () => {
    const updateStatement = payoffBody().split('update public.rent_to_buy_installments set status')[1].split(';')[0]
    expect(updateStatement).toMatch(/sequence = any\(v_snapshot\)/)
  })

  it('18. ownership transfer is guarded to fire at most once (merchant_owned predicate + FOUND check)', () => {
    const body = payoffBody()
    expect(body).toMatch(/where id = p_agreement_id and ownership_status = 'merchant_owned'/)
    expect(body).toMatch(/if found then\s*\n\s*perform public\._rent_to_buy_history\(p_agreement_id, 'system', null, 'ownership_transferred'/)
  })

  it('19. SECURITY DEFINER, search_path, and the service_role auth guard are preserved', () => {
    const body = payoffBody()
    expect(body).toMatch(/security definer set search_path = public/)
    expect(body).toMatch(/if auth\.role\(\) <> 'service_role' then raise exception 'not authorized'; end if;/)
  })

  it('20. grants/revokes reference the unchanged 4-argument signature -- no DROP, no overload created', () => {
    const escaped = PAYOFF_SIGNATURE.replace(/[()]/g, '\\$&')
    expect(sql).toMatch(new RegExp(`revoke all on function public\\.${escaped} from public, anon, authenticated`))
    expect(sql).toMatch(new RegExp(`grant execute on function public\\.${escaped} to service_role`))
    expect(sql).not.toMatch(/drop function if exists public\.payoff_rent_to_buy_agreement/)
  })

  it('21. no refund, credit, or overpayment-correction logic is added', () => {
    const body = payoffBody()
    expect(body).not.toMatch(/refund/i)
    expect(body).not.toMatch(/credit/i)
  })
})

describe('P5D-M3 overall scope guards', () => {
  it('no new table, column, index, enum, or constraint is created -- RPC redefinition only', () => {
    expect(sql).not.toMatch(/create table/i)
    expect(sql).not.toMatch(/add column/i)
    expect(sql).not.toMatch(/create index/i)
    expect(sql).not.toMatch(/create.*constraint|add constraint/i)
    expect(sql).not.toMatch(/create type|alter type/i)
  })

  it('no refund, provider-reference-index, escrow, or webhook-inbox work is included', () => {
    expect(sql).not.toMatch(/payments_provider_reference_unique/)
    expect(sql).not.toMatch(/create.*function.*refund/i)
    expect(sql).not.toMatch(/payment_webhook_events/)
    expect(sql).not.toMatch(/claim_webhook_event_processing|mark_webhook_event_processed|mark_webhook_event_error/)
    expect(sql).not.toMatch(/create_escrow_transaction|create_affiliate_commission|create_merchant_payout/)
  })
})
