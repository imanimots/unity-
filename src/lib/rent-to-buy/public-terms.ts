import { IS_MOCK_MODE } from '@/lib/mock/data'

export interface PublicRentToBuyTerms {
  currency: string
  total_purchase_price: number
  installment_amount: number
  payment_frequency: 'weekly' | 'biweekly' | 'monthly'
  installment_count: number
  security_deposit_amount: number | null
  early_payoff_allowed: boolean
  possession_trigger_type: 'first_payment' | 'installment_count' | 'percentage' | 'full_payment'
  possession_trigger_value: number | null
  rental_use_rate_amount: number
  rental_use_rate_unit: 'daily' | 'weekly' | 'monthly'
  wear_damage_standard: string | null
  grace_period_days: number
  return_window_days: number
}

/**
 * Public-safe RTB terms for a listing -- reads the same enabled=true row
 * the "rtb_listing_terms: public read enabled" RLS policy already exposes
 * (supabase/migrations/20260827000003_rtb_schema.sql), no admin/service
 * client needed. Returns null when RTB isn't offered on this listing at
 * all (disabled, never configured, or mock mode).
 */
export async function getPublicRentToBuyTerms(listingId: string): Promise<PublicRentToBuyTerms | null> {
  if (IS_MOCK_MODE) return null

  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  if (!supabase) return null

  const { data } = await supabase
    .from('rent_to_buy_listing_terms')
    .select(
      'currency, total_purchase_price, installment_amount, payment_frequency, installment_count, security_deposit_amount, early_payoff_allowed, possession_trigger_type, possession_trigger_value, rental_use_rate_amount, rental_use_rate_unit, wear_damage_standard, grace_period_days, return_window_days'
    )
    .eq('listing_id', listingId)
    .eq('enabled', true)
    .maybeSingle()

  return (data as PublicRentToBuyTerms | null) ?? null
}
