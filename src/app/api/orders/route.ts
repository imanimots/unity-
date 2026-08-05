import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { createOrderRequestSchema } from '@/lib/orders/validation'
import { mapOrderRpcError } from '@/lib/orders/rpc-errors'
import { computeCreateOrderHash, checkIdempotentReplay } from '@/lib/orders/idempotency'
import { isKycApproved } from '@/lib/verification/eligibility'
import { blockIfCannotCreate } from '@/lib/admin/account-status'
import { notifyOrderParties } from '@/lib/orders/notify'

/**
 * POST /api/orders -- buy a sale-eligible listing (listing_type 'sale' or
 * 'both'). GET /api/orders -- list the caller's own orders (as buyer
 * and/or seller).
 *
 * create_order() (20260812000004_order_rpcs.sql) is service-role only --
 * the buyer must not be able to supply seller_id, unit_price, or listing
 * status directly. Buying is available to any KYC-approved, non-blocked
 * authenticated user regardless of role (renter/merchant/both) -- same
 * "any authenticated user" eligibility already established for selling
 * in docs/BUYING_SELLING.md's "Open question for Phase 2".
 */
export async function POST(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !anonKey || !serviceKey) {
    return NextResponse.json({ error: 'Order storage is not configured' }, { status: 503 })
  }

  const rate = checkRateLimit(`orders:create:${getClientKey(request)}`, 10, 60_000)
  if (!rate.allowed) {
    return NextResponse.json({ error: 'Too many requests — please slow down' }, { status: 429 })
  }

  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in to buy an item' }, { status: 401 })
  }
  const blocked = blockIfCannotCreate(requester.profile)
  if (blocked) return blocked

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const parsed = createOrderRequestSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid order request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  try {
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    const admin = createServiceClient(url, serviceKey)

    if (parsed.data.idempotency_key) {
      const hash = computeCreateOrderHash(parsed.data.listing_id, parsed.data.quantity)
      const replay = await checkIdempotentReplay(admin, requester.userId, 'create_order', parsed.data.idempotency_key, hash)
      if (replay.status === 'replay') return NextResponse.json(replay.result, { status: 201 })
      if (replay.status === 'conflict') {
        const mapped = mapOrderRpcError('idempotency key already used with a different request')
        return NextResponse.json({ error: mapped.error }, { status: mapped.status })
      }
    }

    // Checked after the idempotency replay above and before the RPC --
    // the established ordering rule for every mutation route in this
    // codebase (an already-completed request must still return its
    // cached result even if KYC status changed since).
    if (!isKycApproved(requester.profile.kyc_status)) {
      return NextResponse.json({ error: 'Your identity must be verified before you can buy an item.' }, { status: 403 })
    }

    const { data, error } = await admin.rpc('create_order', {
      p_buyer_id: requester.userId,
      p_listing_id: parsed.data.listing_id,
      p_quantity: parsed.data.quantity,
      p_idempotency_key: parsed.data.idempotency_key ?? null,
    })

    if (error) {
      console.error('[orders.create] RPC error', { userId: requester.userId, error })
      const mapped = mapOrderRpcError(error.message)
      return NextResponse.json({ error: mapped.error }, { status: mapped.status })
    }

    const orderId = (data as { order_id?: string } | null)?.order_id
    if (orderId) {
      try {
        await notifyOrderParties(admin, orderId, 'order.created', [
          { role: 'buyer', templateId: 'order-created-buyer' },
          { role: 'seller', templateId: 'order-received-seller' },
        ])
      } catch (emailErr) {
        console.error('[orders.create] email dispatch failed', { orderId, emailErr })
      }
    }

    return NextResponse.json(data, { status: 201 })
  } catch (err) {
    console.error('[orders.create] unexpected error', { userId: requester.userId, err })
    return NextResponse.json({ error: 'Could not place your order — please try again' }, { status: 500 })
  }
}

export async function GET(request: NextRequest) {
  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
  }

  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  if (!supabase) {
    return NextResponse.json({ error: 'Order storage is not configured' }, { status: 503 })
  }

  const roleParam = request.nextUrl.searchParams.get('role')
  const statusParam = request.nextUrl.searchParams.get('status')

  // RLS ("orders: parties read") scopes this to rows where the caller is
  // buyer_id or seller_id regardless of the filter applied here.
  let query = supabase.from('orders').select('*').order('created_at', { ascending: false })

  if (roleParam === 'buyer') {
    query = query.eq('buyer_id', requester.userId)
  } else if (roleParam === 'seller') {
    query = query.eq('seller_id', requester.userId)
  } else {
    query = query.or(`buyer_id.eq.${requester.userId},seller_id.eq.${requester.userId}`)
  }
  if (statusParam) {
    query = query.eq('status', statusParam)
  }

  const { data, error } = await query
  if (error) {
    console.error('[orders.list] error', { userId: requester.userId, error })
    return NextResponse.json({ error: 'Could not load orders' }, { status: 500 })
  }

  return NextResponse.json({ orders: data ?? [] })
}
