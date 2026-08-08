import type { SupabaseClient } from '@supabase/supabase-js'
import type { MerchantSubscriptionPlan, MerchantSubscriptionPlanId, MerchantSubscriptionRow } from '@/types'
import { getMerchantSubscriptionPlan } from './plans'

export interface EffectiveMerchantPlan {
  planId: MerchantSubscriptionPlanId
  plan: MerchantSubscriptionPlan
  /** null when the merchant has never had a merchant_subscriptions row -- they've always been implicitly Starter. */
  subscription: MerchantSubscriptionRow | null
}

/**
 * Unity Phase 1's central pricing authority (Step L). The ONE trusted
 * function that answers "what plan is/was in effect for this merchant."
 * Phase 2 (the commission engine) is expected to call this directly --
 * it must never need plan rates copied from a UI constant.
 *
 * Resolution is entirely history-based, which makes it correct for both
 * "now" and any past atTime with no special-casing: the most recent
 * merchant_subscription_history row whose effective_at has already
 * passed (relative to atTime) tells you the plan that was actually in
 * effect at that moment -- including a scheduled-but-not-yet-swept
 * change, since its history row is written (with a future effective_at)
 * at REQUEST time, not at sweep time. No merchant_subscription_history
 * row at or before atTime means the merchant was implicitly on Starter
 * that whole time -- exactly the "no row = Starter, no need for
 * millions of default rows" requirement.
 */
export async function getEffectiveMerchantPlan(
  supabase: SupabaseClient,
  merchantId: string,
  atTime: Date = new Date()
): Promise<EffectiveMerchantPlan> {
  const { data: historyRow, error: historyError } = await supabase
    .from('merchant_subscription_history')
    .select('new_plan_id')
    .eq('merchant_id', merchantId)
    .lte('effective_at', atTime.toISOString())
    .order('effective_at', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (historyError) throw historyError

  const planId = (historyRow?.new_plan_id ?? 'starter') as MerchantSubscriptionPlanId
  const plan = await getMerchantSubscriptionPlan(supabase, planId)
  if (!plan) {
    throw new Error(`merchant_subscription_plans is missing an entry for resolved plan id "${planId}"`)
  }

  const { data: subscription, error: subError } = await supabase
    .from('merchant_subscriptions')
    .select('*')
    .eq('merchant_id', merchantId)
    .maybeSingle()

  if (subError) throw subError

  return { planId, plan, subscription: (subscription as MerchantSubscriptionRow | null) ?? null }
}
