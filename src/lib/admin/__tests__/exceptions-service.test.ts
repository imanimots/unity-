import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  classifyCapturedRtbInstallmentPayment,
  isCapturedRtbDepositUnfunded,
  listOperationalExceptions,
  type RtbInstallmentExceptionCandidate,
  type RtbInstallmentRow,
} from '../exceptions-service'

/**
 * P5D-B.3: DB-free tests for the pure RTB classification helpers,
 * consistent with this file's own established convention
 * (deriveOrderFinancialReadiness in orders-service.ts, etc.) of testing
 * derived logic directly rather than mocking listOperationalExceptions'
 * full multi-wave Supabase query orchestration. Neither function under
 * test takes any webhook-related parameter at all -- the only inputs
 * are payment/installment/agreement rows -- so every result proven here
 * is, by construction, derived purely from persisted financial/domain
 * state, never from payment_webhook_events.status.
 */

function payment(overrides: Partial<RtbInstallmentExceptionCandidate> = {}): RtbInstallmentExceptionCandidate {
  return { id: 'pay-1', rent_to_buy_agreement_id: 'agr-1', amount: '250.00', metadata: {}, ...overrides }
}

function installment(overrides: Partial<RtbInstallmentRow> = {}): RtbInstallmentRow {
  return { sequence: 1, principal_amount: '100.00', status: 'scheduled', payment_id: null, ...overrides }
}

describe('classifyCapturedRtbInstallmentPayment -- legacy uncorrelated (category A)', () => {
  it('1. neither correlation key present surfaces the legacy exception', () => {
    const result = classifyCapturedRtbInstallmentPayment(payment({ metadata: {} }), [])
    expect(result).toEqual({ type: 'rtb_installment_legacy_uncorrelated', summary: expect.any(String) })
  })

  it('2. a valid single-installment sequence never enters the legacy category', () => {
    const result = classifyCapturedRtbInstallmentPayment(payment({ metadata: { rent_to_buy_installment_sequence: 3 } }), [])
    expect(result).toBeNull()
  })

  it('3. a valid, healthy, fully-completed payoff-correlated payment never enters the legacy category', () => {
    const rows = [installment({ sequence: 2, principal_amount: '100.00', status: 'paid', payment_id: 'pay-1' }), installment({ sequence: 3, principal_amount: '150.00', status: 'paid', payment_id: 'pay-1' })]
    const result = classifyCapturedRtbInstallmentPayment(payment({ amount: '250.00', metadata: { rent_to_buy_payoff_sequences: [2, 3] } }), rows)
    expect(result).toBeNull()
  })
})

describe('classifyCapturedRtbInstallmentPayment -- payoff payment_conflict (category B)', () => {
  it('5. a snapshotted sequence already paid by a different payment surfaces payment_conflict', () => {
    const rows = [installment({ sequence: 2, principal_amount: '100.00', status: 'paid', payment_id: 'other-pay' }), installment({ sequence: 3, principal_amount: '150.00', status: 'scheduled' })]
    const result = classifyCapturedRtbInstallmentPayment(payment({ metadata: { rent_to_buy_payoff_sequences: [2, 3] } }), rows)
    expect(result?.type).toBe('rtb_payoff_payment_conflict')
  })

  it('6. a snapshotted sequence already paid by THIS SAME payment is not a conflict', () => {
    const rows = [installment({ sequence: 2, principal_amount: '100.00', status: 'paid', payment_id: 'pay-1' }), installment({ sequence: 3, principal_amount: '150.00', status: 'scheduled' })]
    const result = classifyCapturedRtbInstallmentPayment(payment({ metadata: { rent_to_buy_payoff_sequences: [2, 3] } }), rows)
    expect(result).toBeNull() // still scheduled overall -- awaiting progression, not a permanent condition
  })

  it('7. a scheduled row alone (awaiting progression) never surfaces a conflict', () => {
    const rows = [installment({ sequence: 2, principal_amount: '100.00', status: 'scheduled' }), installment({ sequence: 3, principal_amount: '150.00', status: 'scheduled' })]
    const result = classifyCapturedRtbInstallmentPayment(payment({ metadata: { rent_to_buy_payoff_sequences: [2, 3] } }), rows)
    expect(result).toBeNull()
  })

  it('8. an installment row outside the snapshot is ignored even if it is conflicted', () => {
    const rows = [
      installment({ sequence: 2, principal_amount: '100.00', status: 'scheduled' }),
      installment({ sequence: 3, principal_amount: '150.00', status: 'scheduled' }),
      installment({ sequence: 99, principal_amount: '999.00', status: 'paid', payment_id: 'unrelated-payment' }),
    ]
    const result = classifyCapturedRtbInstallmentPayment(payment({ metadata: { rent_to_buy_payoff_sequences: [2, 3] } }), rows)
    expect(result).toBeNull()
  })
})

describe('classifyCapturedRtbInstallmentPayment -- payoff invalid_snapshot (category C)', () => {
  it('9. incompatible correlation metadata (both keys present) surfaces invalid_snapshot', () => {
    const result = classifyCapturedRtbInstallmentPayment(payment({ metadata: { rent_to_buy_installment_sequence: 1, rent_to_buy_payoff_sequences: [2, 3] } }), [])
    expect(result?.type).toBe('rtb_payoff_invalid_snapshot')
  })

  it('10a. an empty payoff snapshot array surfaces invalid_snapshot', () => {
    const result = classifyCapturedRtbInstallmentPayment(payment({ metadata: { rent_to_buy_payoff_sequences: [] } }), [])
    expect(result?.type).toBe('rtb_payoff_invalid_snapshot')
  })

  it('10b. a malformed (non-array) payoff snapshot surfaces invalid_snapshot, never throws', () => {
    const result = classifyCapturedRtbInstallmentPayment(payment({ metadata: { rent_to_buy_payoff_sequences: 'not-an-array' } }), [])
    expect(result?.type).toBe('rtb_payoff_invalid_snapshot')
  })

  it('10c. a payoff snapshot containing non-integer/zero/negative elements surfaces invalid_snapshot, never throws', () => {
    const result = classifyCapturedRtbInstallmentPayment(payment({ metadata: { rent_to_buy_payoff_sequences: [1, 'x', -2, 0] } }), [])
    expect(result?.type).toBe('rtb_payoff_invalid_snapshot')
  })

  it('11. a snapshotted sequence with no matching installment row (cardinality mismatch) surfaces invalid_snapshot', () => {
    const rows = [installment({ sequence: 2, principal_amount: '100.00', status: 'scheduled' })]
    const result = classifyCapturedRtbInstallmentPayment(payment({ metadata: { rent_to_buy_payoff_sequences: [2, 3] } }), rows)
    expect(result?.type).toBe('rtb_payoff_invalid_snapshot')
  })

  it('12. a payment amount that does not match the exact snapshot principal sum surfaces invalid_snapshot', () => {
    const rows = [installment({ sequence: 2, principal_amount: '100.00', status: 'scheduled' }), installment({ sequence: 3, principal_amount: '150.00', status: 'scheduled' })]
    const result = classifyCapturedRtbInstallmentPayment(payment({ amount: '999.00', metadata: { rent_to_buy_payoff_sequences: [2, 3] } }), rows)
    expect(result?.type).toBe('rtb_payoff_invalid_snapshot')
  })

  it('13. malformed metadata (not an object) never throws and is treated as no correlation at all', () => {
    expect(() => classifyCapturedRtbInstallmentPayment(payment({ metadata: null }), [])).not.toThrow()
    const result = classifyCapturedRtbInstallmentPayment(payment({ metadata: null }), [])
    expect(result?.type).toBe('rtb_installment_legacy_uncorrelated')
  })

  it('14. a valid, fully-completed payoff payment (amount matches, no conflict) never surfaces invalid_snapshot', () => {
    const rows = [installment({ sequence: 2, principal_amount: '100.00', status: 'paid', payment_id: 'pay-1' }), installment({ sequence: 3, principal_amount: '150.00', status: 'paid', payment_id: 'pay-1' })]
    const result = classifyCapturedRtbInstallmentPayment(payment({ amount: '250.00', metadata: { rent_to_buy_payoff_sequences: [2, 3] } }), rows)
    expect(result).toBeNull()
  })
})

describe('classifyCapturedRtbInstallmentPayment -- outcome precedence matches the P5D-M3 RPC exactly', () => {
  it('a cardinality mismatch on one sequence takes precedence over a genuine conflict on another -- resolves to invalid_snapshot, never payment_conflict', () => {
    // Snapshot [2, 3]: sequence 3 has no matching row at all (cardinality
    // issue), while sequence 2 is conflicted (paid by another payment).
    // payoff_rent_to_buy_agreement checks cardinality BEFORE payment
    // conflict -- this must resolve the same way.
    const rows = [installment({ sequence: 2, principal_amount: '100.00', status: 'paid', payment_id: 'other-pay' })]
    const result = classifyCapturedRtbInstallmentPayment(payment({ metadata: { rent_to_buy_payoff_sequences: [2, 3] } }), rows)
    expect(result?.type).toBe('rtb_payoff_invalid_snapshot')
  })

  it('a genuine conflict takes precedence over an amount mismatch -- resolves to payment_conflict, never invalid_snapshot', () => {
    // payoff_rent_to_buy_agreement checks payment_conflict BEFORE amount.
    const rows = [installment({ sequence: 2, principal_amount: '100.00', status: 'paid', payment_id: 'other-pay' }), installment({ sequence: 3, principal_amount: '150.00', status: 'scheduled' })]
    const result = classifyCapturedRtbInstallmentPayment(payment({ amount: '999.00', metadata: { rent_to_buy_payoff_sequences: [2, 3] } }), rows)
    expect(result?.type).toBe('rtb_payoff_payment_conflict')
  })
})

describe('isCapturedRtbDepositUnfunded (category D)', () => {
  it('15. a captured deposit with deposit_funded_at NULL is flagged', () => {
    const result = isCapturedRtbDepositUnfunded({ amount: '500.00', agreement: { security_deposit_amount: '500.00', deposit_funded_at: null } })
    expect(result).toBe(true)
  })

  it('16. once deposit_funded_at is populated, the exception no longer applies', () => {
    const result = isCapturedRtbDepositUnfunded({ amount: '500.00', agreement: { security_deposit_amount: '500.00', deposit_funded_at: '2026-09-01T00:00:00Z' } })
    expect(result).toBe(false)
  })

  it('17. an amount mismatch is excluded, never misreported as a normal unfunded deposit', () => {
    const result = isCapturedRtbDepositUnfunded({ amount: '999.00', agreement: { security_deposit_amount: '500.00', deposit_funded_at: null } })
    expect(result).toBe(false)
  })

  it('18. a missing agreement or unconfigured security deposit is excluded', () => {
    expect(isCapturedRtbDepositUnfunded({ amount: '500.00', agreement: null })).toBe(false)
    expect(isCapturedRtbDepositUnfunded({ amount: '500.00', agreement: { security_deposit_amount: null, deposit_funded_at: null } })).toBe(false)
  })
})

describe('durability -- classification depends only on persisted payment/installment/agreement state', () => {
  it('the classification functions have no parameter representing webhook inbox state at all', () => {
    // Structural proof: both functions' signatures accept only
    // payment/installment/agreement data. There is no webhook-status
    // input to even pass, so the same captured-payment state always
    // classifies the same way regardless of whether the triggering
    // webhook event was ever marked processed.
    const capturedButNeverProgressed = classifyCapturedRtbInstallmentPayment(payment({ metadata: {} }), [])
    expect(capturedButNeverProgressed?.type).toBe('rtb_installment_legacy_uncorrelated')
    const depositCapturedButNeverProgressed = isCapturedRtbDepositUnfunded({ amount: '500.00', agreement: { security_deposit_amount: '500.00', deposit_funded_at: null } })
    expect(depositCapturedButNeverProgressed).toBe(true)
  })
})

/**
 * P5D-AFFILIATE-PAYOUT-LIVENESS-I: listOperationalExceptions() already
 * contains a read-only "stale processing" detector for affiliate
 * commissions (affiliate_commission_provider_result_not_reconciled,
 * keyed on affiliate_commissions.status='processing' and
 * payout_requested_at older than REVIEW_OVERDUE_HOURS) -- this was
 * previously unverified by any test. These tests exercise the REAL
 * function against a minimal fake Supabase client (not a
 * reimplementation of its filtering logic), proving: a stale processing
 * commission is surfaced; a fresh one is not; detection never mutates
 * anything (the required safety invariant -- a processing timeout must
 * never be auto-resolved, auto-retried, or auto-marked paid/failed); and
 * duplicate/concurrent detection is harmless since it is a pure read.
 *
 * The fake only needs real filter semantics for the two tables this
 * category actually reads (affiliate_commissions, exception_resolutions)
 * -- every other table queried by the other ~20 exception categories in
 * the same function resolves to an empty array unconditionally, which is
 * exactly the inert state we want for all of them in this test.
 */
function createFakeExceptionsAdmin(fixtures: { affiliate_commissions?: Row[]; exception_resolutions?: Row[] } = {}) {
  const tables: Record<string, Row[]> = {
    affiliate_commissions: fixtures.affiliate_commissions ?? [],
    exception_resolutions: fixtures.exception_resolutions ?? [],
  }
  const mutationCalls: Array<{ method: string; table: string }> = []

  type Filter = ['eq' | 'neq' | 'lt' | 'gt' | 'gte' | 'in' | 'not_is_null', string, unknown]

  function matches(row: Row, filters: Filter[]): boolean {
    return filters.every(([op, col, val]) => {
      const rowVal = row[col]
      switch (op) {
        case 'eq':
          return rowVal === val
        case 'neq':
          return rowVal !== val
        case 'lt':
          return typeof rowVal === 'string' && typeof val === 'string' && rowVal < val
        case 'gt':
          return typeof rowVal === 'string' && typeof val === 'string' && rowVal > val
        case 'gte':
          return typeof rowVal === 'string' && typeof val === 'string' && rowVal >= val
        case 'in':
          return Array.isArray(val) && val.includes(rowVal)
        case 'not_is_null':
          return rowVal !== null && rowVal !== undefined
      }
    })
  }

  function from(table: string) {
    function select() {
      const filters: Filter[] = []
      const builder = {
        eq(col: string, val: unknown) {
          filters.push(['eq', col, val])
          return builder
        },
        neq(col: string, val: unknown) {
          filters.push(['neq', col, val])
          return builder
        },
        lt(col: string, val: unknown) {
          filters.push(['lt', col, val])
          return builder
        },
        gt(col: string, val: unknown) {
          filters.push(['gt', col, val])
          return builder
        },
        gte(col: string, val: unknown) {
          filters.push(['gte', col, val])
          return builder
        },
        or() {
          return builder
        },
        in(col: string, val: unknown[]) {
          filters.push(['in', col, val])
          return builder
        },
        not(col: string, op: string, val: unknown) {
          if (op === 'is' && val === null) filters.push(['not_is_null', col, null])
          return builder
        },
        is(col: string, val: unknown) {
          filters.push(['eq', col, val])
          return builder
        },
        order() {
          return builder
        },
        limit() {
          return builder
        },
        then(onResolve: (v: { data: Row[]; error: null }) => unknown, onReject?: (e: unknown) => unknown) {
          const rows = (tables[table] ?? []).filter((row) => matches(row, filters))
          return Promise.resolve({ data: rows, error: null }).then(onResolve, onReject)
        },
      }
      return builder
    }
    return {
      select,
      update: vi.fn(() => {
        mutationCalls.push({ method: 'update', table })
        return { eq: () => Promise.resolve({ data: null, error: null }) }
      }),
      insert: vi.fn(() => {
        mutationCalls.push({ method: 'insert', table })
        return { select: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }
      }),
      delete: vi.fn(() => {
        mutationCalls.push({ method: 'delete', table })
        return { eq: () => Promise.resolve({ data: null, error: null }) }
      }),
    }
  }

  // listOperationalExceptions legitimately calls two READ-ONLY (SQL
  // `stable`) RPCs for the unrelated merchant-payout exception
  // categories (_merchant_payout_exception_candidates,
  // _payout_reconcile_missing_candidates) -- those are not mutations and
  // must not trip the "detection never mutates" assertion. Any OTHER rpc
  // name would be a real affiliate-commission state-transition call
  // (mark_affiliate_commission_processing, record_affiliate_payout_result,
  // retry_affiliate_payout, mark_affiliate_commission_paid_manually, etc.)
  // and is tracked as a genuine mutation.
  const READ_ONLY_RPCS = new Set(['_merchant_payout_exception_candidates', '_payout_reconcile_missing_candidates'])
  const rpc = vi.fn((fnName: string) => {
    if (!READ_ONLY_RPCS.has(fnName)) mutationCalls.push({ method: 'rpc', table: fnName })
    return Promise.resolve({ data: [], error: null })
  })

  return { admin: { from, rpc } as unknown as SupabaseClient, mutationCalls }
}

type Row = Record<string, unknown>

function hoursAgoIso(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()
}

function processingCommission(overrides: Row = {}): Row {
  return { id: 'comm-1', listing_id: 'listing-1', status: 'processing', payout_requested_at: hoursAgoIso(49), ...overrides }
}

describe('listOperationalExceptions -- affiliate commission stuck-processing liveness (category: P5D-AFFILIATE-PAYOUT-LIVENESS-I)', () => {
  it('19. a processing commission older than the review-overdue threshold is surfaced as affiliate_commission_provider_result_not_reconciled', async () => {
    const { admin } = createFakeExceptionsAdmin({ affiliate_commissions: [processingCommission()] })
    const exceptions = await listOperationalExceptions(admin)
    const found = exceptions.find((e) => e.type === 'affiliate_commission_provider_result_not_reconciled')
    expect(found).toBeDefined()
    expect(found?.entityType).toBe('affiliate_commission')
    expect(found?.entityId).toBe('comm-1')
    expect(found?.severity).toBe('high')
    expect(found?.resolved).toBe(false)
  })

  it('20. a fresh processing commission (within the threshold) is NOT surfaced as stale', async () => {
    const { admin } = createFakeExceptionsAdmin({ affiliate_commissions: [processingCommission({ payout_requested_at: hoursAgoIso(1) })] })
    const exceptions = await listOperationalExceptions(admin)
    expect(exceptions.find((e) => e.type === 'affiliate_commission_provider_result_not_reconciled')).toBeUndefined()
  })

  it('21. a non-processing commission (e.g. paid) is never classified as stuck-processing regardless of age', async () => {
    const { admin } = createFakeExceptionsAdmin({ affiliate_commissions: [processingCommission({ status: 'paid', payout_requested_at: hoursAgoIso(500) })] })
    const exceptions = await listOperationalExceptions(admin)
    expect(exceptions.find((e) => e.type === 'affiliate_commission_provider_result_not_reconciled')).toBeUndefined()
  })

  it('22. detection never mutates anything -- no update/insert/delete/rpc call is ever made while scanning for stale processing commissions', async () => {
    const { admin, mutationCalls } = createFakeExceptionsAdmin({ affiliate_commissions: [processingCommission()] })
    await listOperationalExceptions(admin)
    expect(mutationCalls).toEqual([])
  })

  it('23. a stale commission is never automatically marked paid or failed, and is never requeued -- it stays exactly "processing" after detection runs', async () => {
    const fixture = processingCommission()
    const { admin } = createFakeExceptionsAdmin({ affiliate_commissions: [fixture] })
    await listOperationalExceptions(admin)
    expect(fixture.status).toBe('processing')
  })

  it('24. duplicate detection is harmless -- running the sweep twice in a row reports the identical exception both times, with no accumulation or double-counting', async () => {
    const { admin } = createFakeExceptionsAdmin({ affiliate_commissions: [processingCommission()] })
    const first = await listOperationalExceptions(admin)
    const second = await listOperationalExceptions(admin)
    const firstMatches = first.filter((e) => e.type === 'affiliate_commission_provider_result_not_reconciled')
    const secondMatches = second.filter((e) => e.type === 'affiliate_commission_provider_result_not_reconciled')
    expect(firstMatches).toHaveLength(1)
    expect(secondMatches).toHaveLength(1)
    expect(firstMatches[0]).toEqual(secondMatches[0])
  })

  it('25. concurrent detection cannot trigger payout execution -- two simultaneous sweeps both report the same stale commission and neither calls a mutation method', async () => {
    const { admin, mutationCalls } = createFakeExceptionsAdmin({ affiliate_commissions: [processingCommission()] })
    const [first, second] = await Promise.all([listOperationalExceptions(admin), listOperationalExceptions(admin)])
    expect(first.filter((e) => e.type === 'affiliate_commission_provider_result_not_reconciled')).toHaveLength(1)
    expect(second.filter((e) => e.type === 'affiliate_commission_provider_result_not_reconciled')).toHaveLength(1)
    expect(mutationCalls).toEqual([])
  })

  it('26. an admin-acknowledged stale commission is reported as resolved without the underlying commission being touched', async () => {
    const fixture = processingCommission()
    const { admin } = createFakeExceptionsAdmin({
      affiliate_commissions: [fixture],
      exception_resolutions: [{ exception_type: 'affiliate_commission_provider_result_not_reconciled', entity_type: 'affiliate_commission', entity_id: 'comm-1' }],
    })
    const exceptions = await listOperationalExceptions(admin)
    const found = exceptions.find((e) => e.type === 'affiliate_commission_provider_result_not_reconciled')
    expect(found?.resolved).toBe(true)
    expect(fixture.status).toBe('processing')
  })

  it('27. existing payout_queued-stuck and failed-payout categories remain intact and distinct from the stale-processing category', async () => {
    const { admin } = createFakeExceptionsAdmin({
      affiliate_commissions: [
        { id: 'comm-queued', listing_id: 'l1', status: 'payout_queued', updated_at: hoursAgoIso(49) },
        { id: 'comm-failed', listing_id: 'l2', status: 'failed', updated_at: hoursAgoIso(1) },
        processingCommission({ id: 'comm-processing' }),
      ],
    })
    const exceptions = await listOperationalExceptions(admin)
    expect(exceptions.find((e) => e.type === 'affiliate_commission_payout_stuck' && e.entityId === 'comm-queued')).toBeDefined()
    expect(exceptions.find((e) => e.type === 'affiliate_commission_payout_failed' && e.entityId === 'comm-failed')).toBeDefined()
    expect(exceptions.find((e) => e.type === 'affiliate_commission_provider_result_not_reconciled' && e.entityId === 'comm-processing')).toBeDefined()
  })
})
