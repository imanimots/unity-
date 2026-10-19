import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { reconcileCommissionRefunds } from '../reconcile'
import { computeAdjustmentHash } from '../idempotency'

/**
 * P5D-COMMISSION-REFUND-ADJUSTMENT-IDEMPOTENCY-I: reconcileCommissionRefunds()
 * had no test coverage at all before this phase. These tests exercise the
 * REAL function (not a reimplementation of its delta logic) against a
 * fake Supabase admin client whose `create_unity_commission_adjustment`
 * RPC simulation mirrors the new migration's own
 * INSERT ... ON CONFLICT (idempotency_key) ... DO NOTHING RETURNING
 * semantics: the conflict check and the winning insert both happen
 * synchronously with no `await` in between, so two genuinely concurrent
 * JS calls racing via Promise.all are serialized by this fake exactly
 * the way two concurrent Postgres transactions inserting the same
 * idempotency_key are serialized by the real unique index -- only the
 * first to actually run its check-and-insert step can win.
 *
 * LIMITATION, stated explicitly per this engagement's own convention:
 * this proves the fake's simulation of the intended SQL behavior, not
 * real multi-connection Postgres execution. No live database is
 * available to this test environment. The companion migration-contract
 * test (reconcile-adjustment-idempotency-migration.test.ts) corroborates
 * that the actual SQL contains the matching structure.
 */

type Row = Record<string, unknown>

function createFakeCommissionsAdmin(fixtures: {
  unity_commissions?: Row[]
  payments?: Row[]
  refunds?: Row[]
  unity_commission_adjustments?: Row[]
} = {}) {
  const tables: Record<string, Row[]> = {
    unity_commissions: fixtures.unity_commissions ?? [],
    payments: fixtures.payments ?? [],
    refunds: fixtures.refunds ?? [],
    unity_commission_adjustments: [...(fixtures.unity_commission_adjustments ?? [])],
  }
  const adjustmentRpcCalls: Row[] = []
  let idCounter = 0

  function matches(row: Row, filters: [string, string, unknown][]): boolean {
    return filters.every(([op, col, val]) => {
      const rowVal = row[col]
      if (op === 'eq') return rowVal === val
      if (op === 'in') return Array.isArray(val) && val.includes(rowVal)
      if (op === 'not_in') return Array.isArray(val) && !val.includes(rowVal)
      return true
    })
  }

  function from(table: string) {
    function select() {
      const filters: [string, string, unknown][] = []
      const builder = {
        eq(col: string, val: unknown) {
          filters.push(['eq', col, val])
          return builder
        },
        in(col: string, val: unknown[]) {
          filters.push(['in', col, val])
          return builder
        },
        not(col: string, _op: string, val: string) {
          // reconcile.ts's only .not() usage here is
          // `.not('status', 'in', '(resolved,closed,cancelled)')` on
          // `disputes`, a table this fixture set never populates --
          // kept as a harmless pass-through for shape compatibility.
          filters.push(['not_in', col, val.replace(/[()]/g, '').split(',')])
          return builder
        },
        order() {
          return builder
        },
        limit() {
          return builder
        },
        or() {
          // Cursor-continuation branch -- never exercised since every
          // fixture here fits in one page (well under
          // UNITY_COMMISSION_SWEEP_BATCH_LIMIT).
          return builder
        },
        then(onResolve: (v: { data: Row[]; error: null }) => unknown, onReject?: (e: unknown) => unknown) {
          const rows = (tables[table] ?? []).filter((row) => matches(row, filters))
          return Promise.resolve({ data: rows, error: null }).then(onResolve, onReject)
        },
      }
      return builder
    }
    return { select }
  }

  function createUnityCommissionAdjustment(params: Row) {
    adjustmentRpcCalls.push(params)
    const commissionId = params.p_commission_id as string
    const amount = params.p_amount as number
    const reason = params.p_reason as string
    const idempotencyKey = (params.p_idempotency_key as string | null) ?? null

    // Atomic claim boundary: synchronous, no await between the conflict
    // check and the winning insert -- matches the real migration's
    // INSERT ... ON CONFLICT ... DO NOTHING RETURNING.
    if (idempotencyKey) {
      const existing = tables.unity_commission_adjustments.find((a) => a.idempotency_key === idempotencyKey)
      if (existing) {
        const amountMatches = Math.round((existing.amount as number) * 100) === Math.round(amount * 100)
        if (existing.commission_id !== commissionId || !amountMatches || existing.reason !== reason) {
          return Promise.resolve({ data: null, error: { message: 'idempotency key already used with a different request' } })
        }
        const commission = tables.unity_commissions.find((c) => c.id === commissionId)
        return Promise.resolve({
          data: { commission_id: commissionId, adjustment_id: existing.id, status: commission?.status, replay: true },
          error: null,
        })
      }
    }

    const id = `adj-${++idCounter}`
    tables.unity_commission_adjustments.push({ id, commission_id: commissionId, amount, reason, idempotency_key: idempotencyKey })
    const commission = tables.unity_commissions.find((c) => c.id === commissionId)
    if (commission) commission.status = 'adjusted'
    return Promise.resolve({ data: { commission_id: commissionId, adjustment_id: id, status: 'adjusted' }, error: null })
  }

  function rpc(fnName: string, params: Row) {
    if (fnName === 'create_unity_commission_adjustment') return createUnityCommissionAdjustment(params)
    if (fnName === 'void_unity_commission' || fnName === 'hold_unity_commission' || fnName === 'release_unity_commission_hold') {
      return Promise.resolve({ data: { status: 'voided' }, error: null })
    }
    throw new Error(`fake admin does not support rpc "${fnName}"`)
  }

  return {
    admin: { from, rpc } as unknown as SupabaseClient,
    getAdjustments: () => tables.unity_commission_adjustments,
    getCommission: (id: string) => tables.unity_commissions.find((c) => c.id === id),
    adjustmentRpcCalls,
  }
}

function commissionRow(overrides: Row = {}): Row {
  return {
    id: 'comm-1',
    status: 'earned',
    payment_id: 'pay-1',
    order_id: 'order-1',
    booking_id: null,
    eligible_base: 1000,
    standard_rate_bps: 1000,
    excess_rate_bps: 0,
    commission_amount: 100,
    created_at: '2026-10-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('reconcileCommissionRefunds -- adjustment idempotency (category: P5D-COMMISSION-REFUND-ADJUSTMENT-IDEMPOTENCY-I)', () => {
  it('1. a first legitimate partial-refund adjustment succeeds and creates exactly one adjustment row', async () => {
    const { admin, getAdjustments, getCommission } = createFakeCommissionsAdmin({
      unity_commissions: [commissionRow()],
      payments: [{ id: 'pay-1', amount: 1000 }],
      refunds: [{ payment_id: 'pay-1', amount: 200, status: 'completed' }],
    })
    const result = await reconcileCommissionRefunds(admin)
    expect(result.adjusted).toBe(1)
    expect(result.failed).toBe(0)
    expect(getAdjustments()).toHaveLength(1)
    expect(getCommission('comm-1')?.status).toBe('adjusted')
  })

  it('2. sequential replay of the same refund state creates no second adjustment -- the convergent delta computation is still intact', async () => {
    const fixtures = {
      unity_commissions: [commissionRow()],
      payments: [{ id: 'pay-1', amount: 1000 }],
      refunds: [{ payment_id: 'pay-1', amount: 200, status: 'completed' }],
    }
    const { admin, getAdjustments } = createFakeCommissionsAdmin(fixtures)
    const first = await reconcileCommissionRefunds(admin)
    const second = await reconcileCommissionRefunds(admin)
    expect(first.adjusted).toBe(1)
    expect(second.adjusted).toBe(0)
    expect(getAdjustments()).toHaveLength(1)
  })

  it('3. concurrent replay of the same refund state creates no second adjustment -- exactly one of two simultaneous sweeps wins the claim', async () => {
    const { admin, getAdjustments } = createFakeCommissionsAdmin({
      unity_commissions: [commissionRow()],
      payments: [{ id: 'pay-1', amount: 1000 }],
      refunds: [{ payment_id: 'pay-1', amount: 200, status: 'completed' }],
    })
    const [first, second] = await Promise.all([reconcileCommissionRefunds(admin), reconcileCommissionRefunds(admin)])
    // Exactly one run actually created the adjustment; the other's RPC
    // call returned a replay (no error, no new row), so its own
    // `adjusted` counter correctly stayed at 0 -- summed across both
    // concurrent runs, exactly one adjustment was really created.
    expect(first.adjusted + second.adjusted).toBe(1)
    expect(first.failed).toBe(0)
    expect(second.failed).toBe(0)
    expect(getAdjustments()).toHaveLength(1)
  })

  it('4. replay produces no duplicate accounting mutation -- the single surviving adjustment amount matches the correctly-computed delta exactly once', async () => {
    const { admin, getAdjustments } = createFakeCommissionsAdmin({
      unity_commissions: [commissionRow()],
      payments: [{ id: 'pay-1', amount: 1000 }],
      refunds: [{ payment_id: 'pay-1', amount: 200, status: 'completed' }],
    })
    await Promise.all([reconcileCommissionRefunds(admin), reconcileCommissionRefunds(admin)])
    const adjustments = getAdjustments()
    expect(adjustments).toHaveLength(1)
    // eligible_base 1000 * (800/1000 retained) = 800 -> commission at
    // 1000bps = 80; currentEffective (commission_amount 100 + 0 prior
    // adjustments) = 100; delta = 80 - 100 = -20.
    expect(Math.round((adjustments[0].amount as number) * 100) / 100).toBe(-20)
  })

  it('5. a same-key conflict with materially different parameters fails closed rather than being silently accepted', async () => {
    const { admin } = createFakeCommissionsAdmin({
      unity_commissions: [commissionRow()],
    })
    const key = computeAdjustmentHash('comm-1', -20, 'partial refund of 200.00 against a payment of 1000.00')
    const first = await (admin as unknown as { rpc: (fn: string, p: Row) => Promise<{ data: Row | null; error: Row | null }> }).rpc(
      'create_unity_commission_adjustment',
      { p_actor_type: 'system', p_actor_id: null, p_commission_id: 'comm-1', p_amount: -20, p_reason: 'partial refund of 200.00 against a payment of 1000.00', p_idempotency_key: key }
    )
    expect(first.error).toBeNull()
    // Same key, but a DIFFERENT amount -- representing a hypothetical
    // caller bug or a stale-vs-fresh adjustment-total race producing a
    // mismatched delta for what should be the same logical event.
    const second = await (admin as unknown as { rpc: (fn: string, p: Row) => Promise<{ data: Row | null; error: Row | null }> }).rpc(
      'create_unity_commission_adjustment',
      { p_actor_type: 'system', p_actor_id: null, p_commission_id: 'comm-1', p_amount: -25, p_reason: 'partial refund of 200.00 against a payment of 1000.00', p_idempotency_key: key }
    )
    expect(second.error).not.toBeNull()
    expect(second.data).toBeNull()
  })

  it('6. a different legitimate refund event (a larger subsequent refund) still creates its own distinct second adjustment', async () => {
    const { admin, getAdjustments } = createFakeCommissionsAdmin({
      unity_commissions: [commissionRow()],
      payments: [{ id: 'pay-1', amount: 1000 }],
      refunds: [{ payment_id: 'pay-1', amount: 200, status: 'completed' }],
    })
    const firstRun = await reconcileCommissionRefunds(admin)
    expect(firstRun.adjusted).toBe(1)

    // A second, larger refund arrives before the next sweep -- a
    // genuinely different business event against the same commission.
    // Modeled as a fresh admin carrying forward the first adjustment
    // plus the new, larger refund total (the real-world equivalent of
    // the next sweep tick reading updated `refunds`/`unity_commissions`
    // state).
    const { admin: admin2, getAdjustments: getAdjustments2 } = createFakeCommissionsAdmin({
      unity_commissions: [commissionRow({ status: 'adjusted' })],
      payments: [{ id: 'pay-1', amount: 1000 }],
      refunds: [{ payment_id: 'pay-1', amount: 500, status: 'completed' }],
      unity_commission_adjustments: getAdjustments(),
    })
    const secondRun = await reconcileCommissionRefunds(admin2)
    expect(secondRun.adjusted).toBe(1)
    expect(getAdjustments2()).toHaveLength(2)
  })

  it('7. existing successful reconcile-refunds behavior remains unchanged for a full refund (void, no adjustment created)', async () => {
    const { admin, getAdjustments } = createFakeCommissionsAdmin({
      unity_commissions: [commissionRow()],
      payments: [{ id: 'pay-1', amount: 1000 }],
      refunds: [{ payment_id: 'pay-1', amount: 1000, status: 'completed' }],
    })
    const result = await reconcileCommissionRefunds(admin)
    expect(result.voided).toBe(1)
    expect(result.adjusted).toBe(0)
    expect(getAdjustments()).toHaveLength(0)
  })

  it('8. existing non-adjustment reconcile-refunds paths remain unchanged -- a commission with no refund at all is scanned but not touched', async () => {
    const { admin, getAdjustments } = createFakeCommissionsAdmin({
      unity_commissions: [commissionRow()],
      payments: [{ id: 'pay-1', amount: 1000 }],
      refunds: [],
    })
    const result = await reconcileCommissionRefunds(admin)
    expect(result.scanned).toBe(1)
    expect(result.considered).toBe(0)
    expect(result.adjusted).toBe(0)
    expect(result.voided).toBe(0)
    expect(getAdjustments()).toHaveLength(0)
  })

  it('9. no external payment/provider call is introduced by this hardening -- the RPC call surface is unchanged (adjustment + void only, no provider methods)', async () => {
    const { admin, adjustmentRpcCalls } = createFakeCommissionsAdmin({
      unity_commissions: [commissionRow()],
      payments: [{ id: 'pay-1', amount: 1000 }],
      refunds: [{ payment_id: 'pay-1', amount: 200, status: 'completed' }],
    })
    await reconcileCommissionRefunds(admin)
    expect(adjustmentRpcCalls).toHaveLength(1)
    expect(adjustmentRpcCalls[0]).not.toHaveProperty('provider')
    expect(adjustmentRpcCalls[0].p_idempotency_key).toBeTruthy()
  })
})
