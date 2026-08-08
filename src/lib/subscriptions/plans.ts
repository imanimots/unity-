import type { SupabaseClient } from '@supabase/supabase-js'
import type { MerchantSubscriptionPlan, MerchantSubscriptionPlanId } from '@/types'

export const MERCHANT_SUBSCRIPTION_PLAN_IDS: MerchantSubscriptionPlanId[] = ['starter', 'pro', 'elite']

/**
 * The one place every consumer (dashboard, admin, economics calculator,
 * future Phase 2 commission engine) reads plan commercial terms from --
 * always the live `merchant_subscription_plans` table, never a
 * hardcoded copy of the rates. Ordered by plan_rank (Starter -> Pro ->
 * Elite).
 */
export async function getMerchantSubscriptionPlans(supabase: SupabaseClient): Promise<MerchantSubscriptionPlan[]> {
  const { data, error } = await supabase
    .from('merchant_subscription_plans')
    .select('*')
    .eq('is_active', true)
    .order('plan_rank', { ascending: true })

  if (error) throw error
  return (data ?? []) as MerchantSubscriptionPlan[]
}

/** Single-plan lookup, including inactive plans (an admin correction may reference a retired plan id for historical display). */
export async function getMerchantSubscriptionPlan(supabase: SupabaseClient, planId: string): Promise<MerchantSubscriptionPlan | null> {
  const { data, error } = await supabase
    .from('merchant_subscription_plans')
    .select('*')
    .eq('id', planId)
    .maybeSingle()

  if (error) throw error
  return data as MerchantSubscriptionPlan | null
}

export function isMerchantSubscriptionPlanId(value: string): value is MerchantSubscriptionPlanId {
  return (MERCHANT_SUBSCRIPTION_PLAN_IDS as string[]).includes(value)
}
