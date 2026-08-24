import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { submitMarketplaceOfferSchema } from '@/lib/marketplace/validation'
import { mapMarketplaceRpcError } from '@/lib/marketplace/rpc-errors'
import { computeSubmitOfferHash, checkIdempotentReplay } from '@/lib/marketplace/idempotency'
import { notifyMarketplaceRequestParty } from '@/lib/marketplace/notify'
import { blockIfCannotCreate } from '@/lib/admin/account-status'

interface RouteParams {
  params: Promise<{ id: string }>
}

/** POST /api/marketplace/requests/[id]/offers -- submit a response (Step F's 4 paths, distinguished by offer_type). */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: requestId } = await params
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) return NextResponse.json({ error: 'Invalid request id' }, { status: 400 })

  const rate = checkRateLimit(`marketplace:offers:submit:${getClientKey(request)}`, 20, 60_000)
  if (!rate.allowed) return NextResponse.json({ error: 'Too many requests — please slow down' }, { status: 429 })

  const responder = await getRequestProfile()
  if (!responder) return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return NextResponse.json({ error: 'Marketplace storage is not configured' }, { status: 503 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  const parsed = submitMarketplaceOfferSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })

  // Only commercial offer types constitute new commercial activity --
  // message_only stays ungated, mirroring the RPC's own KYC condition.
  if (parsed.data.offer_type !== 'message_only') {
    const blocked = blockIfCannotCreate(responder.profile)
    if (blocked) return blocked
  }

  const { createClient: createServiceClient } = await import('@supabase/supabase-js')
  const admin = createServiceClient(url, serviceKey)

  if (parsed.data.idempotency_key) {
    const hash = computeSubmitOfferHash(requestId, parsed.data.offer_type, parsed.data.linked_listing_id, parsed.data.amount)
    const replay = await checkIdempotentReplay(admin, responder.userId, 'submit_marketplace_offer', parsed.data.idempotency_key, hash)
    if (replay.status === 'replay') return NextResponse.json(replay.result)
    if (replay.status === 'conflict') {
      const mapped = mapMarketplaceRpcError('idempotency key already used with a different request')
      return NextResponse.json({ error: mapped.error }, { status: mapped.status })
    }
  }

  const { data, error } = await admin.rpc('submit_marketplace_offer', {
    p_responder_id: responder.userId,
    p_request_id: requestId,
    p_offer_type: parsed.data.offer_type,
    p_linked_listing_id: parsed.data.linked_listing_id ?? null,
    p_amount: parsed.data.amount ?? null,
    p_currency: parsed.data.currency ?? 'ZAR',
    p_rental_start_date: parsed.data.rental_start_date ?? null,
    p_rental_end_date: parsed.data.rental_end_date ?? null,
    p_cash_adjustment: parsed.data.cash_adjustment ?? null,
    p_message: parsed.data.message ?? null,
    p_idempotency_key: parsed.data.idempotency_key ?? null,
  })

  if (error) {
    console.error('[marketplace.offers.submit] RPC error', { userId: responder.userId, requestId, error })
    const mapped = mapMarketplaceRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }

  try {
    const { data: req } = await admin.from('marketplace_requests').select('requester_id').eq('id', requestId).maybeSingle()
    if (req) {
      await notifyMarketplaceRequestParty(admin, requestId, req.requester_id, 'marketplace_request.offer_received', 'marketplace-offer-received', `offer-received-${data.offer_id}`)
    }
  } catch (emailErr) {
    console.error('[marketplace.offers.submit] email dispatch failed', { requestId, emailErr })
  }

  return NextResponse.json(data, { status: 201 })
}
