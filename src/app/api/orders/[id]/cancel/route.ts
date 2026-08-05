import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { cancelOrderSchema } from '@/lib/orders/validation'
import { mapOrderRpcError } from '@/lib/orders/rpc-errors'
import { computeCancelOrderHash, checkIdempotentReplay } from '@/lib/orders/idempotency'
import { notifyOrderParties } from '@/lib/orders/notify'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/orders/[id]/cancel -- either buyer or seller may cancel while
 * 'pending' or 'paid' (pre-shipment). cancel_order() derives which side
 * the caller is on from the order row itself, restores
 * quantity_available, and does not auto-refund a captured payment (same
 * precedent as cancel_booking) -- no account-status gate, matching the
 * booking/barter cancel routes' precedent, since cancelling must remain
 * available even to a restricted/suspended user cleaning up a stale order.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: orderId } = await params
  if (!/^[0-9a-f-]{36}$/i.test(orderId)) {
    return NextResponse.json({ error: 'Invalid order id' }, { status: 400 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Order storage is not configured' }, { status: 503 })
  }

  const rate = checkRateLimit(`orders:cancel:${getClientKey(request)}`, 20, 60_000)
  if (!rate.allowed) {
    return NextResponse.json({ error: 'Too many requests — please slow down' }, { status: 429 })
  }

  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    body = {}
  }
  const parsed = cancelOrderSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  try {
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    const admin = createServiceClient(url, serviceKey)

    if (parsed.data.idempotency_key) {
      const hash = computeCancelOrderHash(orderId, parsed.data.cancellation_reason)
      const replay = await checkIdempotentReplay(admin, requester.userId, 'cancel_order', parsed.data.idempotency_key, hash)
      if (replay.status === 'replay') return NextResponse.json(replay.result)
      if (replay.status === 'conflict') {
        const mapped = mapOrderRpcError('idempotency key already used with a different request')
        return NextResponse.json({ error: mapped.error }, { status: mapped.status })
      }
    }

    const { data, error } = await admin.rpc('cancel_order', {
      p_actor_user_id: requester.userId,
      p_order_id: orderId,
      p_cancellation_reason: parsed.data.cancellation_reason ?? null,
      p_idempotency_key: parsed.data.idempotency_key ?? null,
    })

    if (error) {
      console.error('[orders.cancel] RPC error', { userId: requester.userId, orderId, error })
      const mapped = mapOrderRpcError(error.message)
      return NextResponse.json({ error: mapped.error }, { status: mapped.status })
    }

    try {
      await notifyOrderParties(
        admin,
        orderId,
        'order.cancelled',
        [
          { role: 'buyer', templateId: 'order-cancelled-buyer' },
          { role: 'seller', templateId: 'order-cancelled-seller' },
        ],
        parsed.data.cancellation_reason ? { cancellation_reason: parsed.data.cancellation_reason } : {}
      )
    } catch (emailErr) {
      console.error('[orders.cancel] email dispatch failed', { orderId, emailErr })
    }

    return NextResponse.json(data)
  } catch (err) {
    console.error('[orders.cancel] unexpected error', { userId: requester.userId, orderId, err })
    return NextResponse.json({ error: 'Could not cancel this order — please try again' }, { status: 500 })
  }
}
