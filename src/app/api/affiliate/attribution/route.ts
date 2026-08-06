import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { attributionRequestSchema } from '@/lib/affiliate/validation'
import { mapAffiliateRpcError } from '@/lib/affiliate/rpc-errors'
import { computeOpenAttributionHash, checkIdempotentReplay } from '@/lib/affiliate/idempotency'

/**
 * POST /api/affiliate/attribution -- persists attribution server-side
 * at first opportunity (Decision 4), not deferred to payment time. The
 * caller must be authenticated -- an anonymous cookie entry is only
 * ever consumed the first time its owner authenticates and loads the
 * listing page again; no anonymous attribution row is ever created.
 *
 * The server derives everything from p_referral_code/p_listing_id --
 * the client never supplies an affiliate uuid, a merchant uuid, or any
 * financial value.
 */
export async function POST(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Affiliate storage is not configured' }, { status: 503 })
  }

  const rate = checkRateLimit(`affiliate:attribution:${getClientKey(request)}`, 20, 60_000)
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
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const parsed = attributionRequestSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid fields', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  try {
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    const admin = createServiceClient(url, serviceKey)

    if (parsed.data.idempotency_key) {
      const hash = computeOpenAttributionHash(parsed.data.listing_id, parsed.data.referral_code)
      const replay = await checkIdempotentReplay(admin, requester.userId, 'open_affiliate_attribution', parsed.data.idempotency_key, hash)
      if (replay.status === 'replay') return NextResponse.json(replay.result, { status: 200 })
      if (replay.status === 'conflict') {
        const mapped = mapAffiliateRpcError('idempotency key already used with a different request')
        return NextResponse.json({ error: mapped.error }, { status: mapped.status })
      }
    }

    const { data, error } = await admin.rpc('open_affiliate_attribution', {
      p_referred_user_id: requester.userId,
      p_listing_id: parsed.data.listing_id,
      p_referral_code: parsed.data.referral_code,
      p_source: 'cookie',
      p_idempotency_key: parsed.data.idempotency_key ?? null,
    })

    if (error) {
      console.error('[affiliate.attribution] RPC error', { userId: requester.userId, error })
      const mapped = mapAffiliateRpcError(error.message)
      return NextResponse.json({ error: mapped.error }, { status: mapped.status })
    }

    return NextResponse.json(data, { status: 200 })
  } catch (err) {
    console.error('[affiliate.attribution] unexpected error', { userId: requester.userId, err })
    return NextResponse.json({ error: 'Could not record this referral — please try again' }, { status: 500 })
  }
}
