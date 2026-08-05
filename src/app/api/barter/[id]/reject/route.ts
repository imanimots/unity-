import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { rejectBarterSchema } from '@/lib/barter/validation'
import { mapBarterRpcError } from '@/lib/barter/rpc-errors'
import { computeRejectBarterOfferHash, checkIdempotentReplay } from '@/lib/barter/idempotency'

interface RouteParams {
  params: Promise<{ id: string }>
}

/** POST /api/barter/[id]/reject -- either party may reject the current pending offer, provided they did not propose it. */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: agreementId } = await params
  if (!/^[0-9a-f-]{36}$/i.test(agreementId)) {
    return NextResponse.json({ error: 'Invalid barter agreement id' }, { status: 400 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Barter storage is not configured' }, { status: 503 })
  }

  const rate = checkRateLimit(`barter:reject:${getClientKey(request)}`, 20, 60_000)
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
  const parsed = rejectBarterSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  try {
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    const admin = createServiceClient(url, serviceKey)

    if (parsed.data.idempotency_key) {
      const hash = computeRejectBarterOfferHash(agreementId, parsed.data.rejection_reason)
      const replay = await checkIdempotentReplay(admin, requester.userId, 'reject_barter_offer', parsed.data.idempotency_key, hash)
      if (replay.status === 'replay') return NextResponse.json(replay.result)
      if (replay.status === 'conflict') {
        const mapped = mapBarterRpcError('idempotency key already used with a different request')
        return NextResponse.json({ error: mapped.error }, { status: mapped.status })
      }
    }

    const { data, error } = await admin.rpc('reject_barter_offer', {
      p_actor_user_id: requester.userId,
      p_agreement_id: agreementId,
      p_rejection_reason: parsed.data.rejection_reason ?? null,
      p_idempotency_key: parsed.data.idempotency_key ?? null,
    })

    if (error) {
      console.error('[barter.reject] RPC error', { userId: requester.userId, agreementId, error })
      const mapped = mapBarterRpcError(error.message)
      return NextResponse.json({ error: mapped.error }, { status: mapped.status })
    }

    return NextResponse.json(data)
  } catch (err) {
    console.error('[barter.reject] unexpected error', { userId: requester.userId, agreementId, err })
    return NextResponse.json({ error: 'Could not reject this trade — please try again' }, { status: 500 })
  }
}
