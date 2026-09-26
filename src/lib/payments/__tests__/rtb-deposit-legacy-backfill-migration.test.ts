import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// DB-free regression guards over the raw migration SQL text -- same
// convention as every other RTB migration-contract test in this
// engagement. No database connection, no Supabase CLI: this only
// proves the migration SOURCE contains the invariants P5D-M4.1
// requires, not that it has been applied anywhere.
const REPO_ROOT = join(__dirname, '../../../..')
const migrationPath = join(REPO_ROOT, 'supabase/migrations/20260926180000_backfill_legacy_rtb_deposit_funded_at.sql')
const sql = readFileSync(migrationPath, 'utf-8')

function executableSql(): string {
  const marker = 'with canonical_payment as ('
  const idx = sql.indexOf(marker)
  expect(idx, `expected to find "${marker}" in the migration`).toBeGreaterThanOrEqual(0)
  return sql.slice(idx)
}

function cte(name: string): string {
  const body = executableSql()
  const marker = `${name} as (`
  const idx = body.indexOf(marker)
  expect(idx, `expected to find CTE "${name}"`).toBeGreaterThanOrEqual(0)
  return body.slice(idx)
}

describe('P5D-M4.1 legacy RTB deposit backfill invariants (SQL text)', () => {
  it('exactly one executable statement exists (one WITH...UPDATE), no function definition', () => {
    expect(sql).not.toMatch(/create or replace function/)
    expect(sql).not.toMatch(/\$\$/)
    const matches = sql.match(/^update public\.rent_to_buy_agreements/gm) ?? []
    expect(matches.length).toBe(1)
  })

  it('27a. deposit_funded_at IS NULL is present in the candidate CTE filtering', () => {
    const canonicalPayment = cte('canonical_payment')
    const beforeNextCte = canonicalPayment.split('history_evidence as (')[0]
    expect(beforeNextCte).toMatch(/a\.deposit_funded_at is null/)
  })

  it('27b. deposit_funded_at IS NULL is present again, independently, in the final UPDATE guard', () => {
    const updateStatement = executableSql().split(/^update public\.rent_to_buy_agreements/m)[1]
    expect(updateStatement).toMatch(/a\.deposit_funded_at is null/)
  })

  it('7. canonical payment requires an exact agreement match via rent_to_buy_agreement_id', () => {
    const canonicalPayment = cte('canonical_payment')
    expect(canonicalPayment).toMatch(/p\.rent_to_buy_agreement_id is not null/)
    expect(canonicalPayment).toMatch(/join public\.rent_to_buy_agreements a on a\.id = p\.rent_to_buy_agreement_id/)
  })

  it('8. canonical payment requires payment_type = rent_to_buy_deposit', () => {
    expect(cte('canonical_payment')).toMatch(/p\.payment_type = 'rent_to_buy_deposit'/)
  })

  it('9. canonical payment requires status = captured', () => {
    expect(cte('canonical_payment')).toMatch(/p\.status = 'captured'/)
  })

  it('10. canonical payment requires an exact amount match against security_deposit_amount (no tolerance)', () => {
    const canonicalPayment = cte('canonical_payment')
    expect(canonicalPayment).toMatch(/p\.amount is not distinct from a\.security_deposit_amount/)
    expect(canonicalPayment).not.toMatch(/round\(|abs\(|<=|>=|tolerance/)
  })

  it('11. at least one matching deposit_paid history event is required -- a captured payment alone is never sufficient', () => {
    // safe_candidates INNER JOINs canonical_payment to history_evidence --
    // an agreement with a canonical payment but zero history rows never
    // appears in history_evidence at all (no group-by row), so the join
    // excludes it.
    const safeCandidates = cte('safe_candidates')
    expect(safeCandidates).toMatch(/join history_evidence he on he\.agreement_id = cp\.agreement_id/)
    expect(safeCandidates).not.toMatch(/left join history_evidence/)
  })

  it('12. history evidence is scoped to this exact agreement and event_type = deposit_paid', () => {
    const historyEvidence = cte('history_evidence')
    expect(historyEvidence).toMatch(/from public\.rent_to_buy_history h/)
    expect(historyEvidence).toMatch(/where h\.event_type = 'deposit_paid'/)
    expect(historyEvidence).toMatch(/group by h\.agreement_id/)
  })

  it('13. safe_candidates requires the history-evidenced payment_id to equal the canonical payment id exactly (text comparison)', () => {
    const safeCandidates = cte('safe_candidates')
    expect(safeCandidates).toMatch(/he\.sample_payment_id = cp\.payment_id::text/)
  })

  it('14. a history row with a NULL/missing payment_id is treated as malformed and excludes the agreement from repair', () => {
    const historyEvidence = cte('history_evidence')
    expect(historyEvidence).toMatch(/count\(\*\) filter \(where h\.metadata ->> 'payment_id' is null\) as malformed_count/)
    const safeCandidates = cte('safe_candidates')
    expect(safeCandidates).toMatch(/he\.malformed_count = 0/)
  })

  it('15. history naming a different payment (or multiple distinct identities) excludes the agreement -- distinct_payment_id_count must be exactly 1', () => {
    const historyEvidence = cte('history_evidence')
    expect(historyEvidence).toMatch(/count\(distinct h\.metadata ->> 'payment_id'\) as distinct_payment_id_count/)
    const safeCandidates = cte('safe_candidates')
    expect(safeCandidates).toMatch(/he\.distinct_payment_id_count = 1/)
  })

  it('16. multiple distinct history payment_ids for one agreement are rejected by the same distinct_payment_id_count = 1 guard', () => {
    // Same predicate as test 15 -- this test exists to make the specific
    // ambiguity scenario (>1 distinct id) explicit and separately named,
    // per the phase brief's own separate numbering.
    expect(cte('safe_candidates')).toMatch(/he\.distinct_payment_id_count = 1/)
  })

  it('17. multiple history rows for the SAME canonical payment are explicitly supported, not rejected', () => {
    const historyEvidence = cte('history_evidence')
    // No DISTINCT/LIMIT 1 on the base rows themselves -- only the
    // derived count/min aggregates constrain the result; repeated rows
    // for the same payment_id are counted once by distinct_payment_id_count
    // but do not themselves trigger any rejection.
    expect(historyEvidence).not.toMatch(/limit 1/)
    expect(historyEvidence).toMatch(/min\(h\.created_at\) as earliest_created_at/)
  })

  it('18. the backfill timestamp is MIN(history.created_at), never now() or any other source', () => {
    const historyEvidence = cte('history_evidence')
    expect(historyEvidence).toMatch(/min\(h\.created_at\) as earliest_created_at/)
    const updateStatement = executableSql().split(/^update public\.rent_to_buy_agreements/m)[1]
    expect(updateStatement).toMatch(/set deposit_funded_at = sc\.earliest_created_at/)
    expect(updateStatement).not.toMatch(/now\(\)/)
  })

  it('19. an already-populated deposit_funded_at is never rewritten', () => {
    const updateStatement = executableSql().split(/^update public\.rent_to_buy_agreements/m)[1]
    expect(updateStatement).toMatch(/where a\.id = sc\.agreement_id\s*\n\s*and a\.deposit_funded_at is null/)
  })

  it('20/21. no INSERT, UPDATE, or DELETE against public.payments or public.rent_to_buy_history exists anywhere', () => {
    expect(sql).not.toMatch(/insert into public\.payments/)
    expect(sql).not.toMatch(/update public\.payments/)
    expect(sql).not.toMatch(/delete from public\.payments/)
    expect(sql).not.toMatch(/insert into public\.rent_to_buy_history/)
    expect(sql).not.toMatch(/update public\.rent_to_buy_history/)
    expect(sql).not.toMatch(/delete from public\.rent_to_buy_history/)
  })

  it('22. no rent_to_buy_history row is ever inserted by this migration', () => {
    expect(sql).not.toMatch(/_rent_to_buy_history\(/)
  })

  it('23. no domain progression or settlement helper is called', () => {
    const executable = executableSql()
    expect(executable).not.toMatch(/_rent_to_buy_check_possession_eligibility/)
    expect(executable).not.toMatch(/finalize_rent_to_buy_ownership/)
    expect(executable).not.toMatch(/_rent_to_buy_settle_default_before_possession/)
    expect(executable).not.toMatch(/_rent_to_buy_settle_default_after_possession/)
    expect(executable).not.toMatch(/record_rent_to_buy_deposit_payment/)
  })

  it('25. the only column set by the UPDATE on rent_to_buy_agreements is deposit_funded_at', () => {
    const updateStatement = executableSql().split(/^update public\.rent_to_buy_agreements a\s*\n/m)[1]
    const setClause = updateStatement.split('from safe_candidates')[0]
    expect(setClause.trim()).toBe('set deposit_funded_at = sc.earliest_created_at')
  })

  it('26. the migration is logically idempotent -- the final guard alone is sufficient to make a second application a no-op for already-healed rows', () => {
    const updateStatement = executableSql().split(/^update public\.rent_to_buy_agreements/m)[1]
    expect(updateStatement).toMatch(/a\.deposit_funded_at is null/)
  })

  it('28-31. no schema expansion of any kind exists in this migration', () => {
    expect(sql).not.toMatch(/create table/i)
    expect(sql).not.toMatch(/alter table.*add column/i)
    expect(sql).not.toMatch(/create index/i)
    expect(sql).not.toMatch(/create unique index/i)
    expect(sql).not.toMatch(/add constraint/i)
    expect(sql).not.toMatch(/create type|alter type/i)
  })
})
