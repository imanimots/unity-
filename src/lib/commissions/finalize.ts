import type { SupabaseClient } from '@supabase/supabase-js'
import { UNITY_COMMISSION_REVIEW_HOURS, UNITY_COMMISSION_SWEEP_BATCH_LIMIT } from './constants'

/**
 * pending -> earned once the review window has passed with no refund
 * recorded against the underlying payment and no unresolved dispute.
 * Purely a display/reporting confirmation -- 'earned' carries no
 * different treatment in payout arithmetic than 'pending' (both are
 * "not voided", the only distinction createMerchantPayout()'s ledger
 * read actually needs); it exists so merchants/admins can see which
 * commissions are genuinely final versus still within the reversal
 * window.
 */
export async function finalizeEarnedCommissions(admin: SupabaseClient): Promise<{ finalized: number; considered: number }> {
  const threshold = new Date(Date.now() - UNITY_COMMISSION_REVIEW_HOURS * 60 * 60 * 1000).toISOString()

  const { data: candidates } = await admin
    .from('unity_commissions')
    .select('id, payment_id')
    .eq('status', 'pending')
    .lt('created_at', threshold)
    .limit(UNITY_COMMISSION_SWEEP_BATCH_LIMIT)

  let finalized = 0
  const considered = (candidates ?? []).length

  for (const row of candidates ?? []) {
    const { data: payment } = await admin.from('payments').select('status').eq('id', row.payment_id).maybeSingle()
    if (payment && ['refunded', 'partially_refunded', 'chargeback'].includes(payment.status)) continue

    const { error } = await admin.rpc('finalize_unity_commission', {
      p_actor_type: 'system',
      p_actor_id: null,
      p_commission_id: row.id,
    })
    if (!error) finalized++
  }

  return { finalized, considered }
}
