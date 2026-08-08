import type { SupabaseClient } from '@supabase/supabase-js'

export interface AppliedMerchantSubscriptionChange {
  merchantId: string
  previousPlanId: string
  newPlanId: string
  changeCategory: string
}

/**
 * Lazy-sweep trigger for due scheduled plan changes, mirroring
 * src/lib/barter/lazy-expiry.ts's pattern -- called opportunistically
 * from a read path (GET /api/subscriptions/me, and the admin list/detail
 * routes) rather than requiring a real scheduler.
 * apply_due_merchant_subscription_changes() is naturally idempotent (its
 * own WHERE clause finds nothing left to do on a harmless re-run) and
 * returns the list of merchants it actually changed, so the caller can
 * dispatch "your plan changed" notifications for exactly those merchants.
 *
 * Errors are swallowed, not thrown -- a failed sweep must never turn an
 * otherwise-successful read into a 500.
 */
export async function triggerMerchantSubscriptionLazySweep(admin: SupabaseClient): Promise<AppliedMerchantSubscriptionChange[] | null> {
  try {
    const { data, error } = await admin.rpc('apply_due_merchant_subscription_changes')
    if (error) {
      console.error('[subscriptions.lazy-expiry] sweep RPC error', { error })
      return null
    }
    const applied = (data?.applied ?? []) as Array<{ merchantId: string; previousPlanId: string; newPlanId: string; changeCategory: string }>
    return applied
  } catch (err) {
    console.error('[subscriptions.lazy-expiry] sweep failed', { err })
    return null
  }
}
