import type { SupabaseClient } from '@supabase/supabase-js'
import type { MonthlyVolumeCents } from './economics'

/**
 * Unity Phase 1, Step E -- current-month completed, eligible transaction
 * volume for one merchant, used ONLY for informational economics
 * (savings estimates, plan recommendations). This is deliberately
 * read-only and additive: it does not touch, replace, or influence any
 * existing sale/rental/payout/commission logic. Phase 2 owns the real
 * commission engine.
 *
 * Eligible sales = orders.total_amount - shipping_fee, for orders whose
 * status is 'delivered' (the real terminal state -- order_status has no
 * 'completed' value) and whose delivered_at falls in the current
 * calendar month (UTC). Excludes anything not yet delivered, cancelled
 * orders, and shipping (a pass-through cost, never commissionable).
 *
 * Eligible rentals = the captured rental_charge payment amount for
 * bookings whose status is 'completed' and whose completed_at falls in
 * the current calendar month. Deposits are a different payment_type and
 * are structurally excluded by the payment_type filter alone -- the
 * same exclusion already relied on throughout the payments/payout
 * domain. Refunded/partially_refunded/chargeback payments are excluded
 * by the status filter (only 'captured' counts).
 *
 * Barter contributes nothing here on purpose -- barter is commission-
 * free on every plan, so its volume is never part of this calculation.
 *
 * Money handling: DB numeric columns are rands (2dp); converted to
 * integer cents via Math.round(value * 100), matching the DB's own
 * precision exactly (never introduces drift beyond what's already
 * stored).
 */
export async function getCurrentMonthMerchantVolume(supabase: SupabaseClient, merchantId: string): Promise<MonthlyVolumeCents> {
  const now = new Date()
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0)).toISOString()

  const { data: orders, error: ordersError } = await supabase
    .from('orders')
    .select('total_amount, shipping_fee')
    .eq('seller_id', merchantId)
    .eq('status', 'delivered')
    .gte('delivered_at', monthStart)

  if (ordersError) throw ordersError

  const salesVolumeCents = (orders ?? []).reduce((sum, o) => {
    const net = Number(o.total_amount) - Number(o.shipping_fee ?? 0)
    return sum + Math.max(0, Math.round(net * 100))
  }, 0)

  const { data: bookingIdsRows, error: bookingsError } = await supabase
    .from('bookings')
    .select('id')
    .eq('merchant_id', merchantId)
    .eq('status', 'completed')
    .gte('completed_at', monthStart)

  if (bookingsError) throw bookingsError

  const bookingIds = (bookingIdsRows ?? []).map((b) => b.id)
  let rentalVolumeCents = 0

  if (bookingIds.length > 0) {
    const { data: payments, error: paymentsError } = await supabase
      .from('payments')
      .select('amount')
      .in('booking_id', bookingIds)
      .eq('payment_type', 'rental_charge')
      .eq('status', 'captured')

    if (paymentsError) throw paymentsError

    rentalVolumeCents = (payments ?? []).reduce((sum, p) => sum + Math.round(Number(p.amount) * 100), 0)
  }

  return { salesVolumeCents, rentalVolumeCents }
}
