import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// DB-free regression guards over the raw migration SQL text -- same
// convention as src/lib/checkout/__tests__/architecture.test.ts's own
// "Step 6 migration invariants" block. No database connection, no
// Supabase CLI: this only proves the migration SOURCE contains the
// invariants P5D-M1 requires, not that it has been applied anywhere.
const REPO_ROOT = join(__dirname, '../../../..')
const migrationPath = join(REPO_ROOT, 'supabase/migrations/20260924120000_harden_payment_webhook_event_processing.sql')
const sql = readFileSync(migrationPath, 'utf-8')

function functionBody(name: string): string {
  const marker = `create or replace function public.${name}`
  const idx = sql.indexOf(marker)
  expect(idx, `expected to find "${marker}" in the migration`).toBeGreaterThanOrEqual(0)
  return sql.slice(idx).split('$$;')[0]
}

// Isolates the WHERE clause of the FIRST update-...-returning statement
// in a function body -- the one atomic, ownership-mutating statement --
// distinct from any later reporting SELECT or idempotent-branch logic
// in the same function. Same technique test #8 already used for the
// claim RPC, reused here for mark_webhook_event_processed/_error so
// fencing assertions are checked against the actual mutating predicate,
// not just "this string appears somewhere in the function".
function firstUpdateWhereClause(fnBody: string): string {
  return fnBody.split('where provider = p_provider')[1].split('returning * into v_row;')[0]
}

describe('P5D-M1 webhook inbox migration invariants (regression guards over the SQL text)', () => {
  it('1. adds processing_started_at as a nullable timestamptz column', () => {
    expect(sql).toMatch(/add column if not exists processing_started_at timestamptz/)
  })

  it('2. adds processed_at as a nullable timestamptz column', () => {
    expect(sql).toMatch(/add column if not exists processed_at timestamptz/)
  })

  it('3. adds processing_attempts as a non-negative integer counter, defaulting to 0', () => {
    expect(sql).toMatch(/add column if not exists processing_attempts integer not null default 0 check \(processing_attempts >= 0\)/)
  })

  it('4. adds last_error as a bounded-length nullable text column', () => {
    expect(sql).toMatch(/add column if not exists last_error text check \(last_error is null or char_length\(last_error\) <= 500\)/)
  })

  it('5. widens the processing_status check constraint to include "processing" alongside the four existing values, dropping the old constraint by its Postgres-assigned name first', () => {
    expect(sql).toMatch(/drop constraint if exists payment_webhook_events_processing_status_check/)
    expect(sql).toMatch(
      /add constraint payment_webhook_events_processing_status_check\s+check \(processing_status in \('received', 'processing', 'processed', 'ignored', 'error'\)\)/
    )
  })

  it('6. the claim RPC performs one atomic conditional UPDATE ... RETURNING, never a separate SELECT before it', () => {
    const fnBody = functionBody('claim_webhook_event_processing')
    expect(fnBody).toMatch(/update public\.payment_webhook_events/)
    expect(fnBody).toMatch(/returning \* into v_row;/)
    // The only SELECT in this function must come after the UPDATE
    // (post-hoc state reporting for the not-claimed case), never before
    // it as a separate check-then-act step.
    const updateIdx = fnBody.indexOf('update public.payment_webhook_events')
    const selectIdx = fnBody.indexOf('select * into v_row from public.payment_webhook_events')
    expect(selectIdx).toBeGreaterThan(updateIdx)
  })

  it('7. the claim RPC eligibility WHERE clause allows "received" or "error" unconditionally, and "processing" only when the lease is stale', () => {
    const fnBody = functionBody('claim_webhook_event_processing')
    expect(fnBody).toMatch(/processing_status in \('received', 'error'\)/)
    expect(fnBody).toMatch(/or \(processing_status = 'processing' and processing_started_at < now\(\) - make_interval\(secs => p_stale_after_seconds\)\)/)
  })

  it('8. the claim RPC eligibility WHERE clause never mentions "processed" or "ignored" -- those states are excluded by omission, not a separate rejection branch', () => {
    const fnBody = functionBody('claim_webhook_event_processing')
    const whereClause = fnBody.split('where provider = p_provider')[1].split('returning * into v_row;')[0]
    expect(whereClause).not.toMatch(/'processed'/)
    expect(whereClause).not.toMatch(/'ignored'/)
  })

  it('9. a fresh (non-stale) processing lease is not reclaimable -- the stale check is a strict "<" comparison against processing_started_at, not an unconditional pass-through', () => {
    const fnBody = functionBody('claim_webhook_event_processing')
    expect(fnBody).toMatch(/processing_started_at < now\(\) - make_interval\(secs => p_stale_after_seconds\)/)
    expect(fnBody).not.toMatch(/processing_status = 'processing'\)\s*$/m)
  })

  it('10. processing_attempts is incremented only inside the claim RPC\'s own UPDATE -- mark_webhook_event_processed/_error read and compare it (fencing) but never increment it', () => {
    const claimBody = functionBody('claim_webhook_event_processing')
    const processedBody = functionBody('mark_webhook_event_processed')
    const errorBody = functionBody('mark_webhook_event_error')
    expect(claimBody).toMatch(/processing_attempts = processing_attempts \+ 1/)
    expect(processedBody).not.toMatch(/processing_attempts = processing_attempts \+ 1/)
    expect(errorBody).not.toMatch(/processing_attempts \+ 1/)
    // Both DO reference processing_attempts -- as the fencing token
    // they compare against, not a counter they advance.
    expect(processedBody).toMatch(/processing_attempts = p_expected_processing_attempt/)
    expect(errorBody).toMatch(/processing_attempts = p_expected_processing_attempt/)
  })

  it('11. the claim RPC never writes received_at -- only the original insert (record_webhook_event, untouched by this migration) sets it', () => {
    const fnBody = functionBody('claim_webhook_event_processing')
    expect(fnBody).not.toMatch(/received_at/)
  })

  it('12. the claim RPC has no default for p_stale_after_seconds -- the DB schema never bakes in a specific retry-schedule assumption', () => {
    const signature = sql.slice(sql.indexOf('create or replace function public.claim_webhook_event_processing'), sql.indexOf('returns jsonb'))
    expect(signature).toMatch(/p_stale_after_seconds integer\s*\n\)/)
    expect(signature).not.toMatch(/p_stale_after_seconds integer default/)
  })

  it('13. mark_webhook_event_processed\'s mutating UPDATE clears the processing lease and records processed_at, matched by (provider, provider_event_id) AND the fencing predicate', () => {
    const fnBody = functionBody('mark_webhook_event_processed')
    expect(fnBody).toMatch(/processing_status = 'processed'/)
    expect(fnBody).toMatch(/processed_at = now\(\)/)
    expect(fnBody).toMatch(/processing_started_at = null/)
    const whereClause = firstUpdateWhereClause(fnBody)
    expect(whereClause).toMatch(/and provider_event_id = p_provider_event_id/)
  })

  it('14. mark_webhook_event_error\'s mutating UPDATE clears the lease (immediately reclaimable) and bounds last_error to 500 characters via left()', () => {
    const fnBody = functionBody('mark_webhook_event_error')
    expect(fnBody).toMatch(/processing_status = 'error'/)
    expect(fnBody).toMatch(/processing_started_at = null/)
    expect(fnBody).toMatch(/last_error = left\(p_last_error, 500\)/)
  })

  it('19. mark_webhook_event_processed accepts p_expected_processing_attempt as a required (no-default) integer parameter', () => {
    const signature = sql.slice(
      sql.indexOf('create or replace function public.mark_webhook_event_processed'),
      sql.indexOf('returns jsonb', sql.indexOf('create or replace function public.mark_webhook_event_processed'))
    )
    expect(signature).toMatch(/p_expected_processing_attempt integer/)
    expect(signature).not.toMatch(/p_expected_processing_attempt integer default/)
  })

  it('20. mark_webhook_event_error accepts p_expected_processing_attempt as a required (no-default) integer parameter, ordered before the defaulted p_last_error', () => {
    const signature = sql.slice(
      sql.indexOf('create or replace function public.mark_webhook_event_error'),
      sql.indexOf('returns jsonb', sql.indexOf('create or replace function public.mark_webhook_event_error'))
    )
    expect(signature).toMatch(/p_expected_processing_attempt integer,\s*\n\s*p_last_error text default null/)
  })

  it('21. mark_webhook_event_processed\'s mutating UPDATE requires processing_status = \'processing\' in its own WHERE clause -- not merely elsewhere in the function', () => {
    const fnBody = functionBody('mark_webhook_event_processed')
    const whereClause = firstUpdateWhereClause(fnBody)
    expect(whereClause).toMatch(/and processing_status = 'processing'/)
  })

  it('22. mark_webhook_event_processed\'s mutating UPDATE requires processing_attempts = p_expected_processing_attempt in its own WHERE clause', () => {
    const fnBody = functionBody('mark_webhook_event_processed')
    const whereClause = firstUpdateWhereClause(fnBody)
    expect(whereClause).toMatch(/and processing_attempts = p_expected_processing_attempt/)
  })

  it('23. mark_webhook_event_error\'s mutating UPDATE requires processing_status = \'processing\' in its own WHERE clause', () => {
    const fnBody = functionBody('mark_webhook_event_error')
    const whereClause = firstUpdateWhereClause(fnBody)
    expect(whereClause).toMatch(/and processing_status = 'processing'/)
  })

  it('24. mark_webhook_event_error\'s mutating UPDATE requires processing_attempts = p_expected_processing_attempt in its own WHERE clause', () => {
    const fnBody = functionBody('mark_webhook_event_error')
    const whereClause = firstUpdateWhereClause(fnBody)
    expect(whereClause).toMatch(/and processing_attempts = p_expected_processing_attempt/)
  })

  it('25. a "processed" row can never be mutated to "error" -- mark_webhook_event_error\'s fenced UPDATE only ever matches processing_status = \'processing\', which \'processed\' is not', () => {
    const fnBody = functionBody('mark_webhook_event_error')
    const whereClause = firstUpdateWhereClause(fnBody)
    // The only status literal the mutating WHERE clause matches is
    // 'processing' -- 'processed' never appears as an eligible source
    // state for this UPDATE.
    expect(whereClause).toMatch(/processing_status = 'processing'/)
    expect(whereClause).not.toMatch(/'processed'/)
  })

  it('26. an "ignored" row can never be mutated to "error" -- same fenced UPDATE, same reasoning as processed -> error', () => {
    const fnBody = functionBody('mark_webhook_event_error')
    const whereClause = firstUpdateWhereClause(fnBody)
    expect(whereClause).not.toMatch(/'ignored'/)
  })

  it('27. a "received" row can never be directly marked processed -- mark_webhook_event_processed\'s fenced UPDATE only matches processing_status = \'processing\', never \'received\'', () => {
    const fnBody = functionBody('mark_webhook_event_processed')
    const whereClause = firstUpdateWhereClause(fnBody)
    expect(whereClause).toMatch(/processing_status = 'processing'/)
    expect(whereClause).not.toMatch(/'received'/)
  })

  it('28. a stale attempt N is fenced out once attempt N+1 exists -- both completion RPCs report "lost_claim" when the row\'s processing_attempts no longer equals the caller\'s token, without mutating', () => {
    for (const name of ['mark_webhook_event_processed', 'mark_webhook_event_error']) {
      const fnBody = functionBody(name)
      const postUpdate = fnBody.split('returning * into v_row;')[1]
      expect(postUpdate, `${name} should have a lost_claim branch`).toMatch(/if v_row\.processing_attempts <> p_expected_processing_attempt then/)
      expect(postUpdate).toMatch(/'outcome', 'lost_claim'/)
    }
  })

  it('29. same-token processed retry has an explicit already_processed idempotent branch, checked after the mutating UPDATE (never inside it)', () => {
    const fnBody = functionBody('mark_webhook_event_processed')
    const postUpdate = fnBody.split('returning * into v_row;')[1]
    expect(postUpdate).toMatch(/if v_row\.processing_status = 'processed' and v_row\.processing_attempts = p_expected_processing_attempt then/)
    expect(postUpdate).toMatch(/'outcome', 'already_processed'/)
  })

  it('30. same-token error retry has an explicit already_error idempotent branch, checked after the mutating UPDATE', () => {
    const fnBody = functionBody('mark_webhook_event_error')
    const postUpdate = fnBody.split('returning * into v_row;')[1]
    expect(postUpdate).toMatch(/if v_row\.processing_status = 'error' and v_row\.processing_attempts = p_expected_processing_attempt then/)
    expect(postUpdate).toMatch(/'outcome', 'already_error'/)
  })

  it('31. the idempotent already_processed branch never writes processed_at = now() -- only the fenced first-completion UPDATE does, so a retry can never be told apart from the original by timestamp', () => {
    const fnBody = functionBody('mark_webhook_event_processed')
    const alreadyProcessedBranch = fnBody.split("if v_row.processing_status = 'processed'")[1].split('end if;')[0]
    expect(alreadyProcessedBranch).not.toMatch(/processed_at = now\(\)/)
    // processed_at = now() must appear exactly once in the whole
    // function -- inside the fenced mutating UPDATE, nowhere else.
    expect(fnBody.match(/processed_at = now\(\)/g)?.length).toBe(1)
  })

  it('32. the idempotent already_error branch never rewrites last_error -- the first durable error record for a given attempt is preserved, not replaced by a retry', () => {
    const fnBody = functionBody('mark_webhook_event_error')
    const alreadyErrorBranch = fnBody.split("if v_row.processing_status = 'error'")[1].split('end if;')[0]
    expect(alreadyErrorBranch).not.toMatch(/last_error = /)
    // last_error is written exactly once in the whole function -- inside
    // the fenced mutating UPDATE, nowhere else.
    expect(fnBody.match(/last_error = /g)?.length).toBe(1)
  })

  it('33. every ownership-related outcome is a structured, non-exceptional return value -- the caller never has to infer ownership from an exception message', () => {
    for (const name of ['mark_webhook_event_processed', 'mark_webhook_event_error']) {
      const fnBody = functionBody(name)
      // Exactly one raise exception for "row not found at all" -- every
      // other branch returns a jsonb 'outcome' value instead of raising.
      const exceptionCount = (fnBody.match(/raise exception 'webhook event not found/g) || []).length
      expect(exceptionCount, `${name} should raise exactly once, only for a genuinely missing row`).toBe(1)
      expect(fnBody).toMatch(/'outcome', 'lost_claim'/)
      expect(fnBody).toMatch(/'outcome', 'invalid_state'/)
    }
  })

  it('34. p_expected_processing_attempt is validated as a required positive number before any mutation, in both completion RPCs', () => {
    for (const name of ['mark_webhook_event_processed', 'mark_webhook_event_error']) {
      const fnBody = functionBody(name)
      const validationSection = fnBody.split('update public.payment_webhook_events')[0]
      expect(validationSection, `${name} should validate the token before its UPDATE`).toMatch(
        /if p_expected_processing_attempt is null or p_expected_processing_attempt <= 0 then/
      )
    }
  })

  it('35. record_webhook_event is not redefined by this migration -- the file only adds new, additive functions', () => {
    expect(sql).not.toMatch(/create or replace function public\.record_webhook_event/)
  })

  it('36. every new function is service_role only, matching every existing payment RPC -- no anon/authenticated/public grant, using each function\'s current (post-fencing) signature', () => {
    for (const fn of ['claim_webhook_event_processing(text, text, integer)', 'mark_webhook_event_processed(text, text, integer)', 'mark_webhook_event_error(text, text, integer, text)']) {
      const escaped = fn.replace(/[()]/g, '\\$&')
      expect(sql).toMatch(new RegExp(`revoke all on function public\\.${escaped} from public, anon, authenticated`))
      expect(sql).toMatch(new RegExp(`grant execute on function public\\.${escaped} to service_role`))
    }
  })

  it('37. every new function is SECURITY DEFINER with an explicit search_path and a service_role auth guard, matching existing payment RPC convention', () => {
    for (const name of ['claim_webhook_event_processing', 'mark_webhook_event_processed', 'mark_webhook_event_error']) {
      const fnBody = functionBody(name)
      expect(fnBody, `${name} should be security definer`).toMatch(/security definer/)
      expect(fnBody, `${name} should set search_path`).toMatch(/set search_path = public/)
      expect(fnBody, `${name} should guard on service_role`).toMatch(/if auth\.role\(\) <> 'service_role' then/)
    }
  })

  it('38. no provider_reference unique index and no refund RPC are created by this migration -- explicitly out of P5D-M1/P5D-M1.1 scope', () => {
    expect(sql).not.toMatch(/payments_provider_reference_unique/)
    expect(sql).not.toMatch(/create.*function.*refund/i)
  })
})
