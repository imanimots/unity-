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

  it('10. processing_attempts is incremented only inside the claim RPC\'s own UPDATE, not in mark_webhook_event_processed or mark_webhook_event_error', () => {
    const claimBody = functionBody('claim_webhook_event_processing')
    const processedBody = functionBody('mark_webhook_event_processed')
    const errorBody = functionBody('mark_webhook_event_error')
    expect(claimBody).toMatch(/processing_attempts = processing_attempts \+ 1/)
    expect(processedBody).not.toMatch(/processing_attempts/)
    expect(errorBody).not.toMatch(/processing_attempts \+ 1/)
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

  it('13. mark_webhook_event_processed clears the processing lease and records processed_at, matched strictly by (provider, provider_event_id)', () => {
    const fnBody = functionBody('mark_webhook_event_processed')
    expect(fnBody).toMatch(/processing_status = 'processed'/)
    expect(fnBody).toMatch(/processed_at = now\(\)/)
    expect(fnBody).toMatch(/processing_started_at = null/)
    expect(fnBody).toMatch(/where provider = p_provider\s+and provider_event_id = p_provider_event_id/)
  })

  it('14. mark_webhook_event_error clears the lease (immediately reclaimable) and bounds last_error to 500 characters via left()', () => {
    const fnBody = functionBody('mark_webhook_event_error')
    expect(fnBody).toMatch(/processing_status = 'error'/)
    expect(fnBody).toMatch(/processing_started_at = null/)
    expect(fnBody).toMatch(/last_error = left\(p_last_error, 500\)/)
  })

  it('15. record_webhook_event is not redefined by this migration -- the file only adds new, additive functions', () => {
    expect(sql).not.toMatch(/create or replace function public\.record_webhook_event/)
  })

  it('16. every new function is service_role only, matching every existing payment RPC -- no anon/authenticated/public grant', () => {
    for (const fn of ['claim_webhook_event_processing(text, text, integer)', 'mark_webhook_event_processed(text, text)', 'mark_webhook_event_error(text, text, text)']) {
      const escaped = fn.replace(/[()]/g, '\\$&')
      expect(sql).toMatch(new RegExp(`revoke all on function public\\.${escaped} from public, anon, authenticated`))
      expect(sql).toMatch(new RegExp(`grant execute on function public\\.${escaped} to service_role`))
    }
  })

  it('17. every new function is SECURITY DEFINER with an explicit search_path and a service_role auth guard, matching existing payment RPC convention', () => {
    for (const name of ['claim_webhook_event_processing', 'mark_webhook_event_processed', 'mark_webhook_event_error']) {
      const fnBody = functionBody(name)
      expect(fnBody, `${name} should be security definer`).toMatch(/security definer/)
      expect(fnBody, `${name} should set search_path`).toMatch(/set search_path = public/)
      expect(fnBody, `${name} should guard on service_role`).toMatch(/if auth\.role\(\) <> 'service_role' then/)
    }
  })

  it('18. no provider_reference unique index and no refund RPC are created by this migration -- explicitly out of P5D-M1 scope', () => {
    expect(sql).not.toMatch(/payments_provider_reference_unique/)
    expect(sql).not.toMatch(/create.*function.*refund/i)
  })
})
