import type { SupabaseClient } from '@supabase/supabase-js'
import { UNITY_COMMISSION_SWEEP_BATCH_LIMIT } from './constants'

interface CommissionRow {
  id: string
  status: string
  payment_id: string
  order_id: string | null
  booking_id: string | null
  eligible_base: number
  standard_rate_bps: number
  excess_rate_bps: number
  commission_amount: number
  created_at: string
}

interface DisputeCandidateRow {
  id: string
  status: string
  order_id: string | null
  booking_id: string | null
  created_at: string
}

/**
 * Shared keyset-pagination cursor for both sweeps below. UNITY_COMMISSION_SWEEP_BATCH_LIMIT
 * (100) remains the per-page size, unchanged -- the bug was never that
 * 100 is too small a page, it was that only ONE page was ever fetched.
 * This walks every matching row exactly once per run via an ORDER BY
 * (created_at, id) cursor that is immutable with respect to any status
 * transition a row undergoes during processing -- unlike OFFSET
 * pagination, a row moving out of (or staying within) the `status IN
 * (...)` filter between pages can never cause a later row to be
 * skipped, because the cursor only ever depends on created_at/id, which
 * never change. This also guarantees termination for a row that remains
 * eligible after processing (e.g. a 'held' commission whose dispute is
 * still unresolved stays 'held' forever) -- the cursor still advances
 * past it once its page has been read, so it is examined exactly once
 * per run, never re-fetched in a loop.
 */
async function* fetchCommissionCandidates<T extends { id: string; created_at: string }>(
  admin: SupabaseClient,
  statuses: string[],
  select: string
): AsyncGenerator<{ rows: T[]; fetchError: string | null }> {
  let cursorCreatedAt: string | null = null
  let cursorId: string | null = null

  while (true) {
    let query = admin
      .from('unity_commissions')
      .select(select)
      .in('status', statuses)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(UNITY_COMMISSION_SWEEP_BATCH_LIMIT)

    if (cursorCreatedAt !== null && cursorId !== null) {
      query = query.or(`created_at.gt.${cursorCreatedAt},and(created_at.eq.${cursorCreatedAt},id.gt.${cursorId})`)
    }

    const { data, error } = await query
    if (error) {
      yield { rows: [], fetchError: error.message }
      return
    }

    const rows = (data ?? []) as unknown as T[]
    if (rows.length === 0) return

    yield { rows, fetchError: null }

    const last = rows[rows.length - 1]
    cursorCreatedAt = last.created_at
    cursorId = last.id

    if (rows.length < UNITY_COMMISSION_SWEEP_BATCH_LIMIT) return
  }
}

function uniqueDefined(values: (string | null)[]): string[] {
  return [...new Set(values.filter((v): v is string => v !== null))]
}

/**
 * Rule 9 (disputes): an unresolved dispute on the underlying
 * transaction holds the commission -- it must not silently alter
 * financial history while the final merchant-entitled amount is
 * unresolved. Once the dispute is no longer unresolved, the hold is
 * released; the SAME sweep run then re-evaluates the released
 * commission against the payment's actual refund state (below), so a
 * dispute that concluded with a refund is reconciled in the same pass.
 *
 * The dispute lookup is batched once per page (two `IN (...)` queries
 * covering every order_id/booking_id in the page, not one query per
 * row) -- the only per-row network calls left are the actual
 * hold/release RPC mutations, which cannot be safely batched since each
 * is an independent row-locked state transition.
 *
 * `scanned` counts every candidate row actually examined (deterministic
 * across the whole eligible pool, not capped at one page); `failed`
 * counts a row whose hold/release RPC call itself errored (never
 * silently dropped). A fetch-level error (network/DB failure on the
 * page query itself, not a single row) stops the loop early and is
 * folded into `failed` too, rather than being swallowed -- whatever was
 * already scanned this run stays counted, the caller (the internal
 * route) still receives an honest partial result, never a false
 * "success".
 */
export async function reconcileCommissionDisputes(admin: SupabaseClient): Promise<{ held: number; released: number; scanned: number; failed: number }> {
  let held = 0
  let released = 0
  let scanned = 0
  let failed = 0

  for await (const { rows, fetchError } of fetchCommissionCandidates<DisputeCandidateRow>(
    admin,
    ['pending', 'adjusted', 'held'],
    'id, status, order_id, booking_id, created_at'
  )) {
    if (fetchError) {
      failed++
      break
    }

    const orderIds = uniqueDefined(rows.map((r) => r.order_id))
    const bookingIds = uniqueDefined(rows.map((r) => r.booking_id))

    const unresolvedOrderIds = new Set<string>()
    const unresolvedBookingIds = new Set<string>()
    let pageFetchFailed = false

    if (orderIds.length > 0) {
      const { data, error } = await admin.from('disputes').select('order_id').in('order_id', orderIds).not('status', 'in', '(resolved,closed,cancelled)')
      if (error) pageFetchFailed = true
      else for (const d of data ?? []) if (d.order_id) unresolvedOrderIds.add(d.order_id)
    }
    if (bookingIds.length > 0) {
      const { data, error } = await admin.from('disputes').select('booking_id').in('booking_id', bookingIds).not('status', 'in', '(resolved,closed,cancelled)')
      if (error) pageFetchFailed = true
      else for (const d of data ?? []) if (d.booking_id) unresolvedBookingIds.add(d.booking_id)
    }

    for (const row of rows) {
      scanned++
      if (pageFetchFailed) {
        failed++
        continue
      }
      try {
        const hasUnresolvedDispute = row.order_id ? unresolvedOrderIds.has(row.order_id) : row.booking_id ? unresolvedBookingIds.has(row.booking_id) : false

        if (hasUnresolvedDispute && row.status !== 'held') {
          const { error } = await admin.rpc('hold_unity_commission', {
            p_actor_type: 'system',
            p_actor_id: null,
            p_commission_id: row.id,
            p_reason: 'an unresolved dispute exists on the underlying transaction',
          })
          if (error) failed++
          else held++
        } else if (!hasUnresolvedDispute && row.status === 'held') {
          const { error } = await admin.rpc('release_unity_commission_hold', {
            p_actor_type: 'system',
            p_actor_id: null,
            p_commission_id: row.id,
          })
          if (error) failed++
          else released++
        }
      } catch {
        failed++
      }
    }
  }

  return { held, released, scanned, failed }
}

/**
 * Rule 7 (refunds): a full refund ultimately retains R0 Unity
 * commission (void); a partial refund reduces the eligible base
 * proportionally to how much of the underlying payment was actually
 * refunded, and the commission is recalculated against that reduced
 * base USING THE ORIGINAL SNAPSHOT RATE (never the merchant's current
 * plan -- Phase 2 Step G's historical-pricing invariant applies to a
 * refund-driven recalculation exactly as much as to the original
 * qualification).
 *
 * Idempotent by construction, not by idempotency key: the target
 * effective commission is recomputed from the CURRENT refunded total
 * every run; a delta is only applied (a new adjustment row created)
 * when it differs from the sum of adjustments already recorded. Retrying
 * against an unchanged refund state always computes delta = 0 and
 * creates nothing -- "retry same refund -> no duplicate adjustment" is
 * a property of the convergent computation, not a lookup table.
 *
 * Payments, refunds, and existing adjustments are each fetched once per
 * page via a batched `IN (...)` query -- not once per row -- leaving
 * only the actual void/adjustment RPC mutations as per-row network
 * calls.
 *
 * `scanned` mirrors reconcileCommissionDisputes()'s meaning (every
 * candidate row examined this run, deterministic across the whole
 * pool); `considered` keeps its original, narrower meaning (a candidate
 * with a real refund on it); `failed` counts a row whose lookup or RPC
 * call errored, never silently dropped.
 */
export async function reconcileCommissionRefunds(admin: SupabaseClient): Promise<{ voided: number; adjusted: number; considered: number; scanned: number; failed: number }> {
  let voided = 0
  let adjusted = 0
  let considered = 0
  let scanned = 0
  let failed = 0

  for await (const { rows, fetchError } of fetchCommissionCandidates<CommissionRow>(
    admin,
    ['pending', 'held', 'earned', 'adjusted'],
    'id, status, payment_id, order_id, booking_id, eligible_base, standard_rate_bps, excess_rate_bps, commission_amount, created_at'
  )) {
    if (fetchError) {
      failed++
      break
    }

    const paymentIds = uniqueDefined(rows.map((r) => r.payment_id))
    const commissionIds = rows.map((r) => r.id)
    let pageFetchFailed = false

    const paymentAmountById = new Map<string, number>()
    if (paymentIds.length > 0) {
      const { data, error } = await admin.from('payments').select('id, amount').in('id', paymentIds)
      if (error) pageFetchFailed = true
      else for (const p of data ?? []) paymentAmountById.set(p.id, Number(p.amount))
    }

    const refundedAmountByPaymentId = new Map<string, number>()
    if (paymentIds.length > 0 && !pageFetchFailed) {
      const { data, error } = await admin.from('refunds').select('payment_id, amount').in('payment_id', paymentIds).eq('status', 'completed')
      if (error) pageFetchFailed = true
      else for (const r of data ?? []) refundedAmountByPaymentId.set(r.payment_id, (refundedAmountByPaymentId.get(r.payment_id) ?? 0) + Number(r.amount))
    }

    const adjustmentTotalByCommissionId = new Map<string, number>()
    if (commissionIds.length > 0 && !pageFetchFailed) {
      const { data, error } = await admin.from('unity_commission_adjustments').select('commission_id, amount').in('commission_id', commissionIds)
      if (error) pageFetchFailed = true
      else for (const a of data ?? []) adjustmentTotalByCommissionId.set(a.commission_id, (adjustmentTotalByCommissionId.get(a.commission_id) ?? 0) + Number(a.amount))
    }

    for (const row of rows) {
      scanned++
      if (pageFetchFailed) {
        failed++
        continue
      }
      try {
        const paymentAmount = paymentAmountById.get(row.payment_id)
        if (paymentAmount === undefined) continue

        const refundedAmount = refundedAmountByPaymentId.get(row.payment_id) ?? 0
        if (refundedAmount <= 0) continue

        considered++

        if (refundedAmount >= paymentAmount) {
          if (row.status !== 'voided') {
            const { error } = await admin.rpc('void_unity_commission', {
              p_actor_type: 'system',
              p_actor_id: null,
              p_commission_id: row.id,
              p_reason: 'the underlying payment was fully refunded',
            })
            if (error) failed++
            else voided++
          }
          continue
        }

        // Partial refund: scale the eligible base by the fraction of the
        // payment that remains unrefunded, then reapply the ORIGINAL
        // standard/excess rate snapshot -- never a live plan lookup.
        const retainedFraction = (paymentAmount - refundedAmount) / paymentAmount
        const remainingEligibleBase = round2(Number(row.eligible_base) * retainedFraction)
        const targetCommission = recomputeWithOriginalRates(remainingEligibleBase, row)

        const currentEffective = round2(Number(row.commission_amount) + (adjustmentTotalByCommissionId.get(row.id) ?? 0))
        const delta = round2(targetCommission - currentEffective)

        if (delta !== 0) {
          const { error } = await admin.rpc('create_unity_commission_adjustment', {
            p_actor_type: 'system',
            p_actor_id: null,
            p_commission_id: row.id,
            p_amount: delta,
            p_reason: `partial refund of ${refundedAmount.toFixed(2)} against a payment of ${paymentAmount.toFixed(2)}`,
          })
          if (error) failed++
          else adjusted++
        }
      } catch {
        failed++
      }
    }
  }

  return { voided, adjusted, considered, scanned, failed }
}

/**
 * Rule 7/9's "ultimately corresponds to the amount that remains
 * economically earned" -- recomputed with the commission's own
 * immutable rate snapshot (standard_rate_bps/excess_rate_bps), never a
 * fresh plan lookup. High-value excess only ever applied to a sale in
 * the first place (excess_rate_bps is 0 for every rental and every sale
 * that never crossed the threshold), so scaling both portions down by
 * the same retained fraction and re-deriving the split from the reduced
 * base is mathematically consistent with the original calculation.
 */
function recomputeWithOriginalRates(remainingEligibleBase: number, row: CommissionRow): number {
  const threshold = 100_000
  const hasExcess = row.excess_rate_bps > 0
  const standardBase = hasExcess ? Math.min(remainingEligibleBase, threshold) : remainingEligibleBase
  const excessBase = hasExcess ? Math.max(remainingEligibleBase - threshold, 0) : 0
  const standardPortion = round2((standardBase * row.standard_rate_bps) / 10000)
  const excessPortion = round2((excessBase * row.excess_rate_bps) / 10000)
  return round2(standardPortion + excessPortion)
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}
