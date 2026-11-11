import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

/**
 * E29 migration-contract test for
 * 20261111112418_harden_refund_provider_completion.sql.
 *
 * Scope: complete_dispute_financial_disposition() (E28/E28-R1) had
 * zero awareness of the linked refund's own state -- an admin could
 * close a refund_required disposition (and clear the
 * financial_disposition_pending payout block) while refunds.status
 * was still 'pending', with zero provider evidence a refund ever
 * happened. Separately, `refunds.status = 'completed'` was found to
 * have zero trustworthy producer anywhere in this codebase -- the
 * only thing that has ever set it is a regression script's own raw,
 * unauthenticated table UPDATE.
 *
 * This migration adds two new canonical RPCs mirroring the existing
 * merchant-payout mark_processing/mark_paid two-step pattern
 * (pending -> processing -> completed/failed), synchronizes
 * payments.status via the EXISTING, reused transition_payment_status()
 * on success, auto-completes the linked disposition on success, and
 * hardens complete_dispute_financial_disposition() to require that
 * authority for refund_required (while preserving plain admin
 * attestation, now requiring non-empty notes, for
 * manual_financial_settlement).
 *
 * LIMITATION, per this codebase's established convention: this test
 * parses SQL source text and asserts on its structure. It does not
 * execute against a live Postgres instance.
 */
const REPO_ROOT = join(__dirname, '../../..')
const MIGRATIONS_DIR = join(REPO_ROOT, 'supabase/migrations')
const MIGRATION_FILE = '20261111112418_harden_refund_provider_completion.sql'
const MIGRATION_PATH = join(MIGRATIONS_DIR, MIGRATION_FILE)
const sql = readFileSync(MIGRATION_PATH, 'utf-8')
const codeOnly = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')
const normalized = codeOnly.replace(/\s+/g, ' ').trim()

const E28_FILE = join(MIGRATIONS_DIR, '20261108180657_add_booking_dispute_financial_disposition.sql')
const e28Sql = readFileSync(E28_FILE, 'utf-8')

function extractBody(src: string, marker: string): string {
  const idx = src.indexOf(marker)
  if (idx === -1) throw new Error(`marker not found: ${marker}`)
  const start = src.indexOf('as $$', idx)
  const end = src.indexOf('$$;', start)
  return src.slice(start + 5, end).trim()
}

describe('20261111112418_harden_refund_provider_completion.sql (category: ADMIN-CONTROL-CENTRE-BATCH-E29)', () => {
  it('1. defines exactly 3 functions: start_refund_provider_attempt, record_refund_provider_result, complete_dispute_financial_disposition', () => {
    const creates = codeOnly.match(/create or replace function/gi) ?? []
    expect(creates).toHaveLength(3)
    expect(normalized).toMatch(/create or replace function public\.start_refund_provider_attempt\(/)
    expect(normalized).toMatch(/create or replace function public\.record_refund_provider_result\(/)
    expect(normalized).toMatch(/create or replace function public\.complete_dispute_financial_disposition\(/)
  })
})

describe('E29 -- start_refund_provider_attempt: pending -> processing only', () => {
  const body = extractBody(sql, 'create or replace function public.start_refund_provider_attempt(')

  it('2. is service_role only, admin-id required, idempotency-keyed', () => {
    expect(body).toMatch(/if auth\.role\(\) <> 'service_role' then/)
    expect(body).toMatch(/if p_admin_id is null then/)
    expect(body).toMatch(/where merchant_id = p_admin_id and operation = 'start_refund_provider_attempt' and idempotency_key = p_idempotency_key/)
  })

  it('3. requires the refund to exist and be exactly pending -- never starts an attempt from any other status', () => {
    expect(body).toMatch(/if v_refund\.id is null then\s*\n\s*raise exception 'refund not found';/)
    expect(body).toMatch(/if v_refund\.status <> 'pending' then\s*\n\s*raise exception 'refund is not pending a provider attempt';/)
  })

  it('4. locks the refund row FOR UPDATE before checking its status -- no race between two concurrent attempts', () => {
    const lockIdx = body.indexOf('select id, status into v_refund from public.refunds where id = p_refund_id for update;')
    const checkIdx = body.indexOf("if v_refund.status <> 'pending' then")
    expect(lockIdx).toBeGreaterThan(-1)
    expect(checkIdx).toBeGreaterThan(lockIdx)
  })

  it('5. transitions to processing via a plain UPDATE, fully schema- and enum-qualified for search_path = \'\'', () => {
    expect(body).toMatch(/update public\.refunds set status = 'processing'::public\.refund_status where id = p_refund_id;/)
  })

  it('6. search_path = \'\' and every object reference is schema-qualified', () => {
    const header = normalized.slice(normalized.indexOf('create or replace function public.start_refund_provider_attempt('), normalized.indexOf('as $$'))
    expect(header).toMatch(/set search_path = ''/)
    const bareTableRefs = body.match(/(?<!public\.)\b(refunds|idempotency_keys)\b/g) ?? []
    expect(bareTableRefs).toHaveLength(0)
  })

  it('7. preserves the exact grants -- service_role only', () => {
    expect(normalized).toMatch(/revoke all on function public\.start_refund_provider_attempt\(uuid, uuid, text\) from public, anon, authenticated;/)
    expect(normalized).toMatch(/grant execute on function public\.start_refund_provider_attempt\(uuid, uuid, text\) to service_role;/)
  })
})

describe('E29 -- record_refund_provider_result: processing -> completed/failed, monotonic', () => {
  const body = extractBody(sql, 'create or replace function public.record_refund_provider_result(')

  it('8. is service_role only, admin-id required, validates provider_status, idempotency-keyed', () => {
    expect(body).toMatch(/if auth\.role\(\) <> 'service_role' then/)
    expect(body).toMatch(/if p_admin_id is null then/)
    expect(body).toMatch(/if p_provider_status not in \('completed', 'failed'\) then/)
    expect(body).toMatch(/where merchant_id = p_admin_id and operation = 'record_refund_provider_result' and idempotency_key = p_idempotency_key/)
  })

  it('9. requires the refund to exist and be exactly processing -- rejects a stray call against pending/completed/failed, which is the monotonicity guarantee', () => {
    expect(body).toMatch(/if v_refund\.id is null then\s*\n\s*raise exception 'refund not found';/)
    expect(body).toMatch(/if v_refund\.status <> 'processing' then\s*\n\s*raise exception 'refund is not awaiting a provider result';/)
  })

  it('10. locks both the refund and (on completion) the payment row FOR UPDATE', () => {
    expect(body).toMatch(/select id, payment_id, amount, status into v_refund from public\.refunds where id = p_refund_id for update;/)
    expect(body).toMatch(/select id, status, amount into v_payment from public\.payments where id = v_refund\.payment_id for update;/)
  })

  it('11. computes the cumulative-completed-vs-payment-amount comparison itself, but delegates the actual status transition to the existing transition_payment_status() -- never a second cap/transition formula', () => {
    expect(body).toMatch(/select coalesce\(sum\(amount\), 0\) into v_already_completed\s*\n\s*from public\.refunds\s*\n\s*where payment_id = v_refund\.payment_id and status = 'completed';/)
    expect(body).toMatch(/v_new_payment_status := case when v_already_completed >= v_payment\.amount then 'refunded' else 'partially_refunded' end;/)
    expect(body).toMatch(/perform public\.transition_payment_status\(v_payment\.id, v_new_payment_status, p_provider_reference, null, 'system', null\);/)
    expect(body).not.toMatch(/insert into public\.payments/)
    expect(body).not.toMatch(/update public\.payments\b/)
  })

  it('12. only synchronizes payments.status from a state transition_payment_status() itself already considers valid for this target -- never forces an invalid transition', () => {
    expect(body).toMatch(/if v_payment\.status in \('captured', 'partially_captured', 'partially_refunded'\) then/)
  })

  it('13. the payment-sync and disposition-auto-complete blocks only run when the provider result is completed -- a failed result changes nothing beyond the refund row itself', () => {
    const failedBranchStart = body.indexOf("if p_provider_status = 'completed' then")
    expect(failedBranchStart).toBeGreaterThan(-1)
    const afterCompletedBlock = body.slice(body.indexOf('v_result := jsonb_build_object'))
    expect(afterCompletedBlock).not.toMatch(/update public\.dispute_financial_dispositions/)
  })

  it('14. auto-completes the linked disposition only when one exists AND is still pending -- never regresses an already-completed disposition, and never touches an unrelated one', () => {
    expect(body).toMatch(/select \* into v_disposition from public\.dispute_financial_dispositions where refund_id = p_refund_id for update;/)
    expect(body).toMatch(/if v_disposition\.id is not null and v_disposition\.status = 'pending' then/)
  })

  it('15. the disposition-completion history event records the refund_id and provider_reference for traceability', () => {
    expect(body).toMatch(/'financial_disposition_completed'/)
    expect(body).toMatch(/jsonb_build_object\('disposition_id', v_disposition\.id, 'refund_id', p_refund_id, 'provider_reference', p_provider_reference\)/)
  })

  it('16. search_path = \'\' and every object/enum reference is schema-qualified', () => {
    const markerIdx = normalized.indexOf('create or replace function public.record_refund_provider_result(')
    const header = normalized.slice(markerIdx, normalized.indexOf('as $$', markerIdx))
    expect(header).toMatch(/set search_path = ''/)
    expect(body).toMatch(/status = p_provider_status::public\.refund_status/)
    expect(body).toMatch(/v_new_payment_status public\.payment_status;/)
  })

  it('17. preserves the exact grants -- service_role only', () => {
    expect(normalized).toMatch(/revoke all on function public\.record_refund_provider_result\(uuid, uuid, text, text, text, text\) from public, anon, authenticated;/)
    expect(normalized).toMatch(/grant execute on function public\.record_refund_provider_result\(uuid, uuid, text, text, text, text\) to service_role;/)
  })
})

describe('E29 -- complete_dispute_financial_disposition: type-aware hardening', () => {
  const oldBody = extractBody(e28Sql, 'create or replace function public.complete_dispute_financial_disposition(')
  const newBody = extractBody(sql, 'create or replace function public.complete_dispute_financial_disposition(')

  it('18. every pre-existing check (existence, pending-only) is preserved byte-for-byte', () => {
    expect(newBody).toContain("if v_disposition.id is null then\n    raise exception 'no financial disposition exists for this dispute';\n  end if;")
    expect(newBody).toContain("if v_disposition.status <> 'pending' then\n    raise exception 'this financial disposition is not pending completion';\n  end if;")
  })

  it('19. refund_required now requires the linked refund to be authoritatively completed -- never completes on admin attestation alone', () => {
    const guard = newBody.slice(newBody.indexOf("if v_disposition.disposition_type = 'refund_required' then"), newBody.indexOf("elsif v_disposition.disposition_type"))
    expect(guard).toMatch(/select status into v_refund_status from public\.refunds where id = v_disposition\.refund_id;/)
    expect(guard).toMatch(/if v_refund_status is distinct from 'completed' then/)
  })

  it('20. manual_financial_settlement now requires non-empty completion notes', () => {
    const guard = newBody.slice(newBody.indexOf("elsif v_disposition.disposition_type = 'manual_financial_settlement' then"), newBody.indexOf('end if;', newBody.indexOf("elsif v_disposition.disposition_type = 'manual_financial_settlement' then")))
    expect(guard).toMatch(/if p_completion_notes is null or length\(trim\(p_completion_notes\)\) = 0 then/)
  })

  it('21. no_financial_adjustment is unaffected by the new guard -- it can never reach this function in a pending state (it is created already-completed), confirmed by the guard only branching on refund_required/manual_financial_settlement', () => {
    const guardBlock = newBody.slice(newBody.indexOf("if v_disposition.disposition_type = 'refund_required' then"), newBody.indexOf('end if;\n\n  update public.dispute_financial_dispositions'))
    expect(guardBlock).not.toMatch(/no_financial_adjustment/)
  })

  it('22. removing exactly the new declaration and the new type-aware guard reproduces the E28 body byte-for-byte', () => {
    const guardPattern = /\s*-- E29: type-aware completion authority\.[\s\S]*?end if;\n\n(\s*update public\.dispute_financial_dispositions)/
    const withGuardRemoved = newBody
      .replace('  v_refund_status refund_status;\n', '')
      .replace(guardPattern, '\n\n$1')
    expect(withGuardRemoved).toBe(oldBody)
  })

  it('23. preserves SECURITY DEFINER, search_path = public (E28\'s own convention, deliberately unchanged), and the exact grants', () => {
    const header = normalized.slice(normalized.lastIndexOf('create or replace function public.complete_dispute_financial_disposition('), normalized.indexOf('as $$', normalized.lastIndexOf('create or replace function public.complete_dispute_financial_disposition(')))
    expect(header).toMatch(/security definer/i)
    expect(header).toMatch(/set search_path = public/i)
    expect(normalized).toMatch(/revoke all on function public\.complete_dispute_financial_disposition\(uuid, uuid, text, text\) from public, anon, authenticated;/)
    expect(normalized).toMatch(/grant execute on function public\.complete_dispute_financial_disposition\(uuid, uuid, text, text\) to service_role;/)
  })
})

describe('E29 -- scope and safety contract', () => {
  it('24. never touches resolve_dispute, resolve_booking_dispute, create_refund, record_dispute_financial_disposition, or any payout gate/exception RPC', () => {
    expect(codeOnly).not.toMatch(/function public\.(resolve_dispute|resolve_booking_dispute|create_refund|record_dispute_financial_disposition|_merchant_payout_full_eligibility_block|_merchant_payout_still_safe_to_pay_block|_merchant_payout_exception_candidates|_rtb_merchant_payout_exception_candidates)\(/)
  })

  it('25. never touches ledger_entries, escrow functions, or RTB settlement functions', () => {
    expect(codeOnly).not.toMatch(/ledger_entries/)
    expect(codeOnly).not.toMatch(/function public\.(refund_escrow_transaction|release_escrow_transaction|cancel_escrow_transaction|_rent_to_buy_settle_escrow|_rent_to_buy_settle_default_after_possession|finalize_rent_to_buy_ownership)\(/)
  })

  it('26. never touches disputes, bookings, or dispute_financial_dispositions table/RLS DDL -- function redefinition only', () => {
    expect(codeOnly).not.toMatch(/create table|alter table|create policy|enable row level security/i)
  })

  it('27. this migration itself never issues a top-level data mutation outside a function body', () => {
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

  it('28. no dynamic SQL exists anywhere in this migration', () => {
    expect(codeOnly).not.toMatch(/\bEXECUTE\s+(format|'|")/i)
    expect(codeOnly).not.toMatch(/quote_ident|quote_literal/)
  })

  it('29. is forward-only -- sorts after every pre-existing migration, no historical file modified', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'))
    expect(files).toContain(MIGRATION_FILE)
    const earlier = files.filter((f) => f !== MIGRATION_FILE && f < MIGRATION_FILE)
    expect(earlier.length).toBeGreaterThan(0)
  })
})

describe('pre-existing fact check: create_refund remains the sole producer of a refunds row -- never bypassed', () => {
  it('30. this migration never inserts into public.refunds -- only start_refund_provider_attempt/record_refund_provider_result UPDATE an existing row', () => {
    expect(codeOnly).not.toMatch(/insert into public\.refunds/)
  })
})

describe('pre-existing fact check: refunds.status = completed had zero trustworthy producer before this migration', () => {
  it('31. the only pre-existing producer anywhere in the app/scripts tree is a regression script\'s own direct table UPDATE, never a real RPC or route', () => {
    const srcFiles: string[] = []
    function walk(dir: string) {
      for (const entry of readdirSync(join(REPO_ROOT, dir), { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
        const rel = join(dir, entry.name)
        if (entry.isDirectory()) walk(rel)
        else if (/\.(ts|tsx|mjs)$/.test(entry.name)) srcFiles.push(rel)
      }
    }
    walk('src')
    walk('scripts')
    const producers = srcFiles.filter((f) => {
      const content = readFileSync(join(REPO_ROOT, f), 'utf-8')
      return /from\(\s*['"]refunds['"]\s*\)[\s\S]{0,60}\.update\(/.test(content)
    })
    expect(producers).toEqual(['scripts/verify-commissions-phase2.mjs'])
  })

  it('32. no SQL migration before this one ever UPDATEs refunds.status', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && f < MIGRATION_FILE)
    for (const f of files) {
      const content = readFileSync(join(MIGRATIONS_DIR, f), 'utf-8')
      expect(content, f).not.toMatch(/update\s+public\.refunds\s+set\s+status/i)
    }
  })
})
