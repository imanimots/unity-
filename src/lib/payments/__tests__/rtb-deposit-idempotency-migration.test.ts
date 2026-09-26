import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// DB-free regression guards over the raw migration SQL text -- same
// convention as rtb-payment-intent-migration.test.ts /
// rtb-payoff-snapshot-migration.test.ts. No database connection, no
// Supabase CLI: this only proves the migration SOURCE contains the
// invariants P5D-M4 requires, not that it has been applied anywhere.
const REPO_ROOT = join(__dirname, '../../../..')
const migrationPath = join(REPO_ROOT, 'supabase/migrations/20260926150000_restore_rtb_deposit_funding_idempotency.sql')
const sql = readFileSync(migrationPath, 'utf-8')

const SIGNATURE = 'record_rent_to_buy_deposit_payment(uuid, uuid, text)'

function functionBody(): string {
  const marker = 'create or replace function public.record_rent_to_buy_deposit_payment'
  const idx = sql.indexOf(marker)
  expect(idx, `expected to find "${marker}" in the migration`).toBeGreaterThanOrEqual(0)
  const nextIdx = sql.indexOf(marker, idx + 1)
  expect(nextIdx, 'expected exactly one definition of record_rent_to_buy_deposit_payment').toBe(-1)
  return sql.slice(idx).split('$$;')[0]
}

describe('P5D-M4 record_rent_to_buy_deposit_payment function-contract invariants (SQL text)', () => {
  it('1. the function signature is unchanged (uuid, uuid, text default null) -- no DROP anywhere in this migration', () => {
    const signature = sql.slice(sql.indexOf('create or replace function public.record_rent_to_buy_deposit_payment'), sql.indexOf('returns jsonb'))
    expect(signature).toMatch(/p_agreement_id uuid, p_payment_id uuid, p_idempotency_key text default null/)
    expect(sql).not.toMatch(/drop function/i)
  })

  it('2. SECURITY DEFINER is preserved', () => {
    expect(functionBody()).toMatch(/security definer/)
  })

  it('3. search_path is preserved', () => {
    expect(functionBody()).toMatch(/set search_path = public/)
  })

  it('4. the service_role auth guard is preserved', () => {
    expect(functionBody()).toMatch(/if auth\.role\(\) <> 'service_role' then raise exception 'not authorized'; end if;/)
  })

  it('5. the agreement row is locked FOR UPDATE', () => {
    expect(functionBody()).toMatch(/select \* into v_agreement from public\.rent_to_buy_agreements where id = p_agreement_id for update/)
  })

  it('6. the payment row is loaded by p_payment_id', () => {
    expect(functionBody()).toMatch(/select id, rent_to_buy_agreement_id, payment_type, status, amount into v_payment\s*\n\s*from public\.payments where id = p_payment_id/)
  })

  it('7. payment existence is validated', () => {
    const body = functionBody()
    expect(body).toMatch(/if v_payment\.id is null then raise exception 'payment not found'; end if;/)
  })

  it('8. the payment must belong to the target agreement', () => {
    const body = functionBody()
    expect(body).toMatch(/if v_payment\.rent_to_buy_agreement_id is distinct from p_agreement_id then/)
    expect(body).toMatch(/raise exception 'payment does not belong to this agreement'/)
  })

  it('9. payment_type must be exactly rent_to_buy_deposit', () => {
    const body = functionBody()
    expect(body).toMatch(/if v_payment\.payment_type <> 'rent_to_buy_deposit' then/)
  })

  it('10. payment.status must be exactly captured', () => {
    const body = functionBody()
    expect(body).toMatch(/if v_payment\.status <> 'captured' then/)
    expect(body).toMatch(/raise exception 'payment has not been captured'/)
  })

  it('11. payment.amount is checked against the agreement\'s security_deposit_amount', () => {
    const body = functionBody()
    expect(body).toMatch(/if v_payment\.amount is distinct from v_agreement\.security_deposit_amount then/)
    expect(body).toMatch(/raise exception 'payment amount does not match the agreement''s configured security deposit amount'/)
  })

  it('12. every payment validation occurs BEFORE the deposit_funded_at idempotent-return check', () => {
    const body = functionBody()
    const paymentValidationEnd = body.indexOf("raise exception 'payment amount does not match")
    const idempotentReturnIdx = body.indexOf('if v_agreement.deposit_funded_at is not null then')
    expect(paymentValidationEnd).toBeGreaterThan(-1)
    expect(idempotentReturnIdx).toBeGreaterThan(-1)
    expect(paymentValidationEnd).toBeLessThan(idempotentReturnIdx)
  })
})

describe('P5D-M4 idempotency invariants (SQL text)', () => {
  it('13. deposit_funded_at is not null produces a structured already_paid success', () => {
    const body = functionBody()
    expect(body).toMatch(/if v_agreement\.deposit_funded_at is not null then/)
    const idempotentBranch = body.split('if v_agreement.deposit_funded_at is not null then')[1].split('end if;')[0]
    expect(idempotentBranch).toMatch(/'already_paid', true/)
  })

  it('14. the same-payment idempotent branch never inserts a deposit_paid history row', () => {
    const body = functionBody()
    const idempotentBranch = body.split('if v_agreement.deposit_funded_at is not null then')[1].split('end if;')[0]
    expect(idempotentBranch).not.toMatch(/_rent_to_buy_history/)
  })

  it('15. the same-payment idempotent branch never rewrites deposit_funded_at', () => {
    const body = functionBody()
    const idempotentBranch = body.split('if v_agreement.deposit_funded_at is not null then')[1].split('end if;')[0]
    expect(idempotentBranch).not.toMatch(/update public\.rent_to_buy_agreements/)
  })

  it('16. a first clean completion sets deposit_funded_at = now()', () => {
    const body = functionBody()
    const freshSection = body.split('-- First clean completion.')[1]
    expect(freshSection).toMatch(/update public\.rent_to_buy_agreements set deposit_funded_at = now\(\) where id = p_agreement_id/)
  })

  it('17. a first clean completion inserts exactly one deposit_paid history event', () => {
    const body = functionBody()
    const freshSection = body.split('-- First clean completion.')[1]
    const matches = freshSection.match(/_rent_to_buy_history\(p_agreement_id, 'system', null, 'deposit_paid'/g) ?? []
    expect(matches.length).toBe(1)
  })

  it('18. the orphaned possession-eligibility helper is never called', () => {
    expect(functionBody()).not.toMatch(/_rent_to_buy_check_possession_eligibility/)
  })

  it('19. p_idempotency_key is never parsed for business/payment identity', () => {
    const body = functionBody()
    expect(body).not.toMatch(/split_part\(p_idempotency_key/)
    expect(body).not.toMatch(/substring\(p_idempotency_key/)
  })
})

describe('P5D-M4 legacy broken-state healing invariants (SQL text)', () => {
  it('20. a canonical historical deposit_paid event is detected via agreement + exact validated payment_id + event_type', () => {
    const body = functionBody()
    const query = body.split('select min(created_at) into v_legacy_funded_at')[1]?.split(';')[0]
    expect(query, 'expected the legacy-detection query to exist').toBeDefined()
    expect(query).toMatch(/from public\.rent_to_buy_history/)
    expect(query).toMatch(/agreement_id = p_agreement_id/)
    expect(query).toMatch(/event_type = 'deposit_paid'/)
    expect(query).toMatch(/metadata ->> 'payment_id' = p_payment_id::text/)
  })

  it('21. deposit_funded_at NULL plus a matching historical event enters the healing branch', () => {
    const body = functionBody()
    expect(body).toMatch(/if v_legacy_funded_at is not null then/)
  })

  it('22. the healing branch sets deposit_funded_at from the historical timestamp', () => {
    const body = functionBody()
    const healingBranch = body.split('if v_legacy_funded_at is not null then')[1].split('end if;')[0]
    expect(healingBranch).toMatch(/update public\.rent_to_buy_agreements set deposit_funded_at = v_legacy_funded_at where id = p_agreement_id/)
  })

  it('23. the healing branch never inserts another deposit_paid history event', () => {
    const body = functionBody()
    const healingBranch = body.split('if v_legacy_funded_at is not null then')[1].split('end if;')[0]
    expect(healingBranch).not.toMatch(/_rent_to_buy_history/)
  })

  it('24. multiple matching legacy history rows are collapsed via min(created_at), never causing a second insertion', () => {
    const body = functionBody()
    expect(body).toMatch(/select min\(created_at\) into v_legacy_funded_at/)
  })

  it('25. the deterministic historical timestamp is used, never now(), for the healing branch', () => {
    const body = functionBody()
    const healingBranch = body.split('if v_legacy_funded_at is not null then')[1].split('end if;')[0]
    expect(healingBranch).not.toMatch(/now\(\)/)
    expect(healingBranch).toMatch(/v_legacy_funded_at/)
  })

  it('26. the legacy-detection query is scoped to the already-validated canonical payment -- history belonging to another payment id can never match', () => {
    const body = functionBody()
    const query = body.split('select min(created_at) into v_legacy_funded_at')[1].split(';')[0]
    expect(query).toMatch(/metadata ->> 'payment_id' = p_payment_id::text/)
    expect(query).not.toMatch(/order by created_at desc/)
  })

  it('27. there is no fallback path that treats unmatched/malformed history as healing evidence', () => {
    const body = functionBody()
    // The ONLY branch that sets deposit_funded_at from history is gated
    // strictly on v_legacy_funded_at being non-null, which itself can
    // only be non-null when the exact-match query above found a row.
    const setStatements = body.match(/set deposit_funded_at = [^\s]+/g) ?? []
    expect(setStatements.sort()).toEqual(['set deposit_funded_at = now()', 'set deposit_funded_at = v_legacy_funded_at'].sort())
  })
})

describe('P5D-M4 invalid-payment rejection invariants (SQL text)', () => {
  it('28. wrong agreement is rejected before any mutation', () => {
    const body = functionBody()
    const validation = body.split('if v_agreement.deposit_funded_at is not null then')[0]
    expect(validation).toMatch(/raise exception 'payment does not belong to this agreement'/)
  })

  it('29. wrong payment_type is rejected before any mutation', () => {
    const body = functionBody()
    const validation = body.split('if v_agreement.deposit_funded_at is not null then')[0]
    expect(validation).toMatch(/raise exception 'payment is not a rent-to-buy deposit payment'/)
  })

  it('30. a non-captured payment is rejected before any mutation', () => {
    const body = functionBody()
    const validation = body.split('if v_agreement.deposit_funded_at is not null then')[0]
    expect(validation).toMatch(/raise exception 'payment has not been captured'/)
  })

  it('31. an amount mismatch is rejected before any mutation', () => {
    const body = functionBody()
    const validation = body.split('if v_agreement.deposit_funded_at is not null then')[0]
    expect(validation).toMatch(/raise exception 'payment amount does not match/)
  })

  it('32. a missing payment is rejected before any mutation', () => {
    const body = functionBody()
    const validation = body.split('if v_agreement.deposit_funded_at is not null then')[0]
    expect(validation).toMatch(/raise exception 'payment not found'/)
  })

  it('33. an invalid payment can never reach the already_paid idempotent-return path -- all raises precede it in source order', () => {
    const body = functionBody()
    const idempotentReturnIdx = body.indexOf('if v_agreement.deposit_funded_at is not null then')
    for (const reason of ['payment not found', 'payment does not belong to this agreement', 'payment is not a rent-to-buy deposit payment', 'payment has not been captured', 'payment amount does not match']) {
      const idx = body.indexOf(reason)
      expect(idx, `expected to find rejection reason "${reason}"`).toBeGreaterThan(-1)
      expect(idx).toBeLessThan(idempotentReturnIdx)
    }
  })
})

describe('P5D-M4 schema/scope guards', () => {
  it('34-37. no new table, column, index, or constraint is created -- RPC redefinition only', () => {
    expect(sql).not.toMatch(/create table/i)
    expect(sql).not.toMatch(/add column/i)
    expect(sql).not.toMatch(/create index/i)
    expect(sql).not.toMatch(/create.*constraint|add constraint/i)
    expect(sql).not.toMatch(/create type|alter type/i)
  })

  it('39. no other RPC (settlement, default, possession, installment) is redefined in this migration', () => {
    const matches = sql.match(/create or replace function public\.\w+/g) ?? []
    expect(matches).toEqual(['create or replace function public.record_rent_to_buy_deposit_payment'])
  })

  it('grants/revokes reference only the unchanged 3-argument signature', () => {
    const escaped = SIGNATURE.replace(/[()]/g, '\\$&')
    expect(sql).toMatch(new RegExp(`revoke all on function public\\.${escaped} from public, anon, authenticated`))
    expect(sql).toMatch(new RegExp(`grant execute on function public\\.${escaped} to service_role`))
  })

  it('no refund, credit, or provider-reference-index work is included', () => {
    expect(sql).not.toMatch(/create.*function.*refund/i)
    expect(sql).not.toMatch(/payments_provider_reference_unique/)
    expect(sql).not.toMatch(/create_affiliate_commission|create_merchant_payout|create_escrow_transaction/)
  })
})
