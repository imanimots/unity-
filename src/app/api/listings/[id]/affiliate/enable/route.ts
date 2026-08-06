import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { listingAffiliateToggleSchema } from '@/lib/affiliate/validation'
import { mapAffiliateRpcError } from '@/lib/affiliate/rpc-errors'
import { notifyMerchantOfAffiliateEvent } from '@/lib/affiliate/notify'

interface RouteParams {
  params: Promise<{ id: string }>
}

/** POST /api/listings/[id]/affiliate/enable -- the listing's own merchant only. */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: listingId } = await params
  if (!/^[0-9a-f-]{36}$/i.test(listingId)) {
    return NextResponse.json({ error: 'Invalid listing id' }, { status: 400 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Listing storage is not configured' }, { status: 503 })
  }

  const rate = checkRateLimit(`listings:affiliate:enable:${getClientKey(request)}`, 20, 60_000)
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
  const parsed = listingAffiliateToggleSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  try {
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    const admin = createServiceClient(url, serviceKey)

    const { data, error } = await admin.rpc('enable_listing_affiliate', {
      p_actor_type: 'merchant',
      p_actor_id: requester.userId,
      p_listing_id: listingId,
      p_reason: null,
      p_idempotency_key: parsed.data.idempotency_key ?? null,
    })

    if (error) {
      console.error('[listings.affiliate.enable] RPC error', { userId: requester.userId, listingId, error })
      const mapped = mapAffiliateRpcError(error.message)
      return NextResponse.json({ error: mapped.error }, { status: mapped.status })
    }

    try {
      await notifyMerchantOfAffiliateEvent(
        admin,
        listingId,
        'merchant.affiliate_enabled',
        'merchant-affiliate-enabled',
        parsed.data.idempotency_key ?? `enable-${Date.now()}`
      )
    } catch (emailErr) {
      console.error('[listings.affiliate.enable] email dispatch failed', { listingId, emailErr })
    }

    return NextResponse.json(data)
  } catch (err) {
    console.error('[listings.affiliate.enable] unexpected error', { userId: requester.userId, listingId, err })
    return NextResponse.json({ error: 'Could not enable affiliates for this listing — please try again' }, { status: 500 })
  }
}
