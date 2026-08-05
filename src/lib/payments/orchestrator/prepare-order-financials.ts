import type { OrchestratorContext } from './types'
import { OrchestrationError } from './errors'

const ELIGIBLE_ORDER_STATUSES = ['pending', 'paid']

/**
 * Ensures the order_payment payment exists for an order. Never calls a
 * provider -- mirrors prepareBookingFinancials()'s shape exactly, minus
 * the deposit branch (buy/sell has no deposit concept). Amount is always
 * read from the order's own immutable total_amount (set once at
 * create_order()), never passed in.
 *
 * Idempotent by construction: payments_order_type_unique (order_id,
 * payment_type) means calling this twice for the same order always
 * resolves to the same payment id.
 */
export async function prepareOrderFinancials(
  ctx: OrchestratorContext,
  orderId: string,
  idempotencyKey?: string
): Promise<{ paymentId: string }> {
  const { admin } = ctx
  const providerName = ctx.providerName || process.env.PAYMENT_PROVIDER || 'mock'

  const { data: order, error: orderError } = await admin
    .from('orders')
    .select('id, status, total_amount')
    .eq('id', orderId)
    .maybeSingle()

  if (orderError || !order) {
    throw new OrchestrationError('missing_payment', 'Order not found')
  }
  if (!ELIGIBLE_ORDER_STATUSES.includes(order.status)) {
    throw new OrchestrationError('invalid_booking_state', `Order status "${order.status}" is not eligible to prepare financials`)
  }

  const { data: existing } = await admin.from('payments').select('id').eq('order_id', orderId).eq('payment_type', 'order_payment').maybeSingle()
  if (existing) return { paymentId: existing.id }

  const { data, error } = await admin.rpc('create_order_payment_intent', {
    p_order_id: orderId,
    p_amount: order.total_amount,
    p_currency: 'ZAR',
    p_provider: providerName,
    p_idempotency_key: idempotencyKey ? `${idempotencyKey}-intent` : null,
  })

  if (error) {
    throw new OrchestrationError('internal_consistency_error', `Could not create order payment: ${error.message}`)
  }
  return { paymentId: data.payment_id }
}
