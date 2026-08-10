import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { acceptOfferSchema } from '@/lib/marketplace/validation'
import { mapMarketplaceRpcError } from '@/lib/marketplace/rpc-errors'
import { computeAcceptOfferHash, checkIdempotentReplay } from '@/lib/marketplace/idempotency'
import { notifyMarketplaceRequestParty } from '@/lib/marketplace/notify'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/marketplace/offers/[id]/accept -- the critical transition
 * (Step S). accept_marketplace_offer() is concurrency-safe (locks the
 * request row first, then the offer) and creates a REAL order/booking/
 * barter agreement via the existing, unmodified creation RPCs. No
 * commission/affiliate/escrow logic lives in this route or the RPC --
 * those existing systems trigger later, exactly as they already do for
 * any normal order/booking/barter agreement.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: offerId } = await params
  if (!/^[0-9a-f-]{36}$/i.test(offerId)) return NextResponse.json({ error: 'Invalid offer id' }, { status: 400 })

  const rate = checkRateLimit(`marketplace:offers:accept:${getClientKey(request)}`, 20, 60_000)
  if (!rate.allowed) return NextResponse.json({ error: 'Too many requests — please slow down' }, { status: 429 })

  const requester = await getRequestProfile()
  if (!requester) return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return NextResponse.json({ error: 'Marketplace storage is not configured' }, { status: 503 })

  let body: unknown
  try { body = await request.json() } catch { body = {} }
  const parsed = acceptOfferSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })

  const { createClient: createServiceClient } = await import('@supabase/supabase-js')
  const admin = createServiceClient(url, serviceKey)

  if (parsed.data.idempotency_key) {
    const hash = computeAcceptOfferHash(offerId)
    const replay = await checkIdempotentReplay(admin, requester.userId, 'accept_marketplace_offer', parsed.data.idempotency_key, hash)
    if (replay.status === 'replay') return NextResponse.json(replay.result)
    if (replay.status === 'conflict') {
      const mapped = mapMarketplaceRpcError('idempotency key already used with a different request')
      return NextResponse.json({ error: mapped.error }, { status: mapped.status })
    }
  }

  const { data, error } = await admin.rpc('accept_marketplace_offer', {
    p_actor_user_id: requester.userId, p_offer_id: offerId, p_idempotency_key: parsed.data.idempotency_key ?? null,
  })

  if (error) {
    console.error('[marketplace.offers.accept] RPC error', { userId: requester.userId, offerId, error })
    const mapped = mapMarketplaceRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }

  try {
    const { data: offer } = await admin.from('marketplace_request_offers').select('responder_id').eq('id', offerId).maybeSingle()
    if (offer) {
      await notifyMarketplaceRequestParty(admin, data.request_id, offer.responder_id, 'marketplace_request.offer_accepted', 'marketplace-offer-accepted', `offer-accepted-${offerId}`)
    }
  } catch (emailErr) {
    console.error('[marketplace.offers.accept] email dispatch failed', { offerId, emailErr })
  }

  return NextResponse.json(data)
}
