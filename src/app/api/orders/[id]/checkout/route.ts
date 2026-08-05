import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { orderCheckoutRequestSchema } from '@/lib/orders/validation'
import { isMockScenarioSelectionAllowed } from '@/lib/checkout/test-scenario'
import { chargeOrderPayment, OrchestrationError, isRetryableOrchestrationError } from '@/lib/payments/orchestrator'
import { blockIfCannotTransact } from '@/lib/admin/account-status'
import { notifyOrderParties } from '@/lib/orders/notify'

/**
 * order.payment_failed only fires for a confirmed payment-layer failure,
 * never a request-layer error (those all return before chargeOrderPayment()
 * is ever called) and never internal_consistency_error, which means the
 * payment itself SUCCEEDED but mark_order_paid failed afterward -- sending
 * "your payment failed" for that case would be actively wrong.
 */
const PAYMENT_FAILURE_CODES = new Set(['provider_declined', 'terminal_provider_error', 'retryable_provider_error', 'provider_timeout'])

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/orders/[id]/checkout -- the single trusted route for paying
 * a pending order. Mirrors POST /api/bookings/[id]/checkout's shape, but
 * chargeOrderPayment() is a single-step operation (no
 * financial_workflows resumability needed -- see that function's own
 * comment), so this route is simpler: no eligibility/readiness
 * derivation module, order.status is itself the readiness signal.
 *
 * The browser sends only idempotency_key and (mock mode only) a raw
 * test_scenario -- amount, status, and provider references are always
 * derived server-side from the order's own immutable total_amount.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: orderId } = await params
  if (!/^[0-9a-f-]{36}$/i.test(orderId)) {
    return NextResponse.json({ error: 'Invalid order id' }, { status: 400 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Checkout is not configured' }, { status: 503 })
  }

  const rate = checkRateLimit(`orders:checkout:${getClientKey(request)}`, 20, 60_000)
  if (!rate.allowed) {
    return NextResponse.json({ error: 'Too many requests — please slow down' }, { status: 429 })
  }

  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
  }
  const blocked = blockIfCannotTransact(requester.profile)
  if (blocked) return blocked

  let body: unknown
  try {
    body = await request.json()
  } catch {
    body = {}
  }
  const parsed = orderCheckoutRequestSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  if (parsed.data.test_scenario && !isMockScenarioSelectionAllowed()) {
    return NextResponse.json({ error: 'Test scenario selection is not permitted in this environment' }, { status: 400 })
  }

  const { createClient: createServiceClient } = await import('@supabase/supabase-js')
  const admin = createServiceClient(url, serviceKey)

  try {
    const { data: order } = await admin.from('orders').select('id, buyer_id, status').eq('id', orderId).maybeSingle()
    if (!order || order.buyer_id !== requester.userId) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 })
    }
    if (order.status !== 'pending') {
      return NextResponse.json({ error: `This order is not awaiting payment (status: ${order.status})` }, { status: 422 })
    }

    const result = await chargeOrderPayment(
      { admin, testRentalScenario: parsed.data.test_scenario },
      orderId,
      parsed.data.idempotency_key
    )

    try {
      await notifyOrderParties(admin, orderId, 'order.payment_received', [
        { role: 'buyer', templateId: 'order-payment-received-buyer' },
        { role: 'seller', templateId: 'order-payment-received-seller' },
      ])
    } catch (emailErr) {
      console.error('[orders.checkout] email dispatch failed', { orderId, emailErr })
    }

    return NextResponse.json({ status: 'success', paymentId: result.paymentId, orderStatus: result.orderStatus })
  } catch (err) {
    if (err instanceof OrchestrationError) {
      console.error('[orders.checkout] orchestration error', { orderId, code: err.code, message: err.message })

      if (PAYMENT_FAILURE_CODES.has(err.code)) {
        try {
          await notifyOrderParties(admin, orderId, 'order.payment_failed', [{ role: 'buyer', templateId: 'order-payment-failed-buyer' }])
        } catch (emailErr) {
          console.error('[orders.checkout] failure email dispatch failed', { orderId, emailErr })
        }
      }

      if (isRetryableOrchestrationError(err.code)) {
        return NextResponse.json(
          { status: 'failed_retryable', error: 'A temporary issue stopped this payment. Please try again.' },
          { status: 503 }
        )
      }
      if (err.code === 'provider_declined' || err.code === 'terminal_provider_error') {
        return NextResponse.json({ status: 'failed_terminal', error: err.message }, { status: 200 })
      }
      return NextResponse.json({ error: 'Checkout could not be completed — please try again' }, { status: 500 })
    }

    console.error('[orders.checkout] unexpected error', { orderId, err })
    return NextResponse.json({ error: 'Checkout could not be completed — please try again' }, { status: 500 })
  }
}
