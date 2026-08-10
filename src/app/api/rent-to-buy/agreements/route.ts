import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { createRentToBuyRequestSchema } from '@/lib/rent-to-buy/validation'
import { mapRentToBuyRpcError } from '@/lib/rent-to-buy/rpc-errors'
import { computeCreateRequestHash, checkIdempotentReplay } from '@/lib/rent-to-buy/idempotency'
import { isRentToBuyEnabled } from '@/lib/rent-to-buy/config'

/**
 * POST /api/rent-to-buy/agreements -- customer initiates directly
 * against an "Available" RTB-enabled listing (the Looking For path
 * instead flows through accept_marketplace_offer's rent_to_buy branch,
 * which calls the same create_rent_to_buy_request RPC).
 *
 * GET /api/rent-to-buy/agreements -- the caller's own agreements (as
 * merchant or customer), scoped by RLS.
 */
export async function POST(request: NextRequest) {
  const rate = checkRateLimit(`rent-to-buy:agreements:create:${getClientKey(request)}`, 15, 60_000)
  if (!rate.allowed) return NextResponse.json({ error: 'Too many requests — please slow down' }, { status: 429 })

  if (!isRentToBuyEnabled()) return NextResponse.json({ error: 'Rent-to-buy is not currently available' }, { status: 503 })

  const requester = await getRequestProfile()
  if (!requester) return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  const parsed = createRentToBuyRequestSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return NextResponse.json({ error: 'Rent-to-buy storage is not configured' }, { status: 503 })
  const { createClient: createServiceClient } = await import('@supabase/supabase-js')
  const admin = createServiceClient(url, serviceKey)

  if (parsed.data.idempotency_key) {
    const hash = computeCreateRequestHash(parsed.data.listing_id)
    const replay = await checkIdempotentReplay(admin, requester.userId, 'create_rent_to_buy_request', parsed.data.idempotency_key, hash)
    if (replay.status === 'replay') return NextResponse.json(replay.result, { status: 201 })
    if (replay.status === 'conflict') {
      const mapped = mapRentToBuyRpcError('idempotency key already used with a different request')
      return NextResponse.json({ error: mapped.error }, { status: mapped.status })
    }
  }

  const { data, error } = await admin.rpc('create_rent_to_buy_request', {
    p_customer_id: requester.userId,
    p_listing_id: parsed.data.listing_id,
    p_request_id: null,
    p_offer_id: null,
    p_idempotency_key: parsed.data.idempotency_key ?? null,
  })

  if (error) {
    console.error('[rent-to-buy.agreements.create] RPC error', { userId: requester.userId, error })
    const mapped = mapRentToBuyRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }
  return NextResponse.json(data, { status: 201 })
}

export async function GET() {
  const requester = await getRequestProfile()
  if (!requester) return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anonKey) return NextResponse.json({ error: 'Rent-to-buy storage is not configured' }, { status: 503 })

  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  if (!supabase) return NextResponse.json({ error: 'Rent-to-buy storage is not configured' }, { status: 503 })

  const { data, error } = await supabase
    .from('rent_to_buy_agreements')
    .select('id, listing_id, merchant_id, customer_id, status, possession_status, ownership_status, total_purchase_price, currency, created_at')
    .or(`merchant_id.eq.${requester.userId},customer_id.eq.${requester.userId}`)
    .order('created_at', { ascending: false })
    .limit(100)

  if (error) return NextResponse.json({ error: 'Could not load agreements' }, { status: 500 })
  return NextResponse.json({ agreements: data ?? [] })
}
