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
}

/**
 * Rule 9 (disputes): an unresolved dispute on the underlying
 * transaction holds the commission -- it must not silently alter
 * financial history while the final merchant-entitled amount is
 * unresolved. Once the dispute is no longer unresolved, the hold is
 * released; the SAME sweep run then re-evaluates the released
 * commission against the payment's actual refund state (below), so a
 * dispute that concluded with a refund is reconciled in the same pass.
 */
export async function reconcileCommissionDisputes(admin: SupabaseClient): Promise<{ held: number; released: number }> {
  let held = 0
  let released = 0

  const { data: candidates } = await admin
    .from('unity_commissions')
    .select('id, status, order_id, booking_id')
    .in('status', ['pending', 'adjusted', 'held'])
    .limit(UNITY_COMMISSION_SWEEP_BATCH_LIMIT)

  for (const row of candidates ?? []) {
    const disputeQuery = row.order_id
      ? admin.from('disputes').select('id').eq('order_id', row.order_id).not('status', 'in', '(resolved,closed,cancelled)').maybeSingle()
      : admin.from('disputes').select('id').eq('booking_id', row.booking_id as string).not('status', 'in', '(resolved,closed,cancelled)').maybeSingle()
    const { data: unresolvedDispute } = await disputeQuery

    if (unresolvedDispute && row.status !== 'held') {
      const { error } = await admin.rpc('hold_unity_commission', {
        p_actor_type: 'system',
        p_actor_id: null,
        p_commission_id: row.id,
        p_reason: 'an unresolved dispute exists on the underlying transaction',
      })
      if (!error) held++
    } else if (!unresolvedDispute && row.status === 'held') {
      const { error } = await admin.rpc('release_unity_commission_hold', {
        p_actor_type: 'system',
        p_actor_id: null,
        p_commission_id: row.id,
      })
      if (!error) released++
    }
  }

  return { held, released }
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
 */
export async function reconcileCommissionRefunds(admin: SupabaseClient): Promise<{ voided: number; adjusted: number; considered: number }> {
  const { data: candidates } = await admin
    .from('unity_commissions')
    .select('id, status, payment_id, order_id, booking_id, eligible_base, standard_rate_bps, excess_rate_bps, commission_amount')
    .in('status', ['pending', 'held', 'earned', 'adjusted'])
    .limit(UNITY_COMMISSION_SWEEP_BATCH_LIMIT)

  let voided = 0
  let adjusted = 0
  let considered = 0

  for (const row of (candidates ?? []) as CommissionRow[]) {
    const { data: payment } = await admin.from('payments').select('amount').eq('id', row.payment_id).maybeSingle()
    if (!payment) continue

    const { data: refundRows } = await admin.from('refunds').select('amount').eq('payment_id', row.payment_id).eq('status', 'completed')
    const refundedAmount = (refundRows ?? []).reduce((sum, r) => sum + Number(r.amount), 0)
    if (refundedAmount <= 0) continue

    considered++
    const paymentAmount = Number(payment.amount)

    if (refundedAmount >= paymentAmount) {
      if (row.status !== 'voided') {
        const { error } = await admin.rpc('void_unity_commission', {
          p_actor_type: 'system',
          p_actor_id: null,
          p_commission_id: row.id,
          p_reason: 'the underlying payment was fully refunded',
        })
        if (!error) voided++
      }
      continue
    }

    // Partial refund: scale the eligible base by the fraction of the
    // payment that remains unrefunded, then reapply the ORIGINAL
    // standard/excess rate snapshot -- never a live plan lookup.
    const retainedFraction = (paymentAmount - refundedAmount) / paymentAmount
    const remainingEligibleBase = round2(Number(row.eligible_base) * retainedFraction)
    const targetCommission = recomputeWithOriginalRates(remainingEligibleBase, row)

    const { data: existingAdjustments } = await admin.from('unity_commission_adjustments').select('amount').eq('commission_id', row.id)
    const currentEffective = round2(Number(row.commission_amount) + (existingAdjustments ?? []).reduce((sum, a) => sum + Number(a.amount), 0))
    const delta = round2(targetCommission - currentEffective)

    if (delta !== 0) {
      const { error } = await admin.rpc('create_unity_commission_adjustment', {
        p_actor_type: 'system',
        p_actor_id: null,
        p_commission_id: row.id,
        p_amount: delta,
        p_reason: `partial refund of ${refundedAmount.toFixed(2)} against a payment of ${paymentAmount.toFixed(2)}`,
      })
      if (!error) adjusted++
    }
  }

  return { voided, adjusted, considered }
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
