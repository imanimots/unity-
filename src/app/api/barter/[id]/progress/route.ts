import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { markBarterProgressSchema } from '@/lib/barter/validation'
import { mapBarterRpcError } from '@/lib/barter/rpc-errors'
import { computeMarkBarterProgressHash, checkIdempotentReplay } from '@/lib/barter/idempotency'
import { notifyBarterParties } from '@/lib/barter/notify'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/barter/[id]/progress -- either party marks the trade's
 * physical-exchange progress forward (Step 11 Phase 4):
 * accepted -> preparing -> (in_transit ->) awaiting_confirmation.
 * mark_barter_progress() is the real authority on which transitions are
 * legal from the current status (including the financial-readiness gate
 * and delivery-method branching) -- this route only forwards the
 * request.
 */
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

  const rate = checkRateLimit(`barter:progress:${getClientKey(request)}`, 20, 60_000)
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
  const parsed = markBarterProgressSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  try {
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    const admin = createServiceClient(url, serviceKey)

    if (parsed.data.idempotency_key) {
      const hash = computeMarkBarterProgressHash(agreementId, parsed.data.target_status)
      const replay = await checkIdempotentReplay(admin, requester.userId, 'mark_barter_progress', parsed.data.idempotency_key, hash)
      if (replay.status === 'replay') return NextResponse.json(replay.result)
      if (replay.status === 'conflict') {
        const mapped = mapBarterRpcError('idempotency key already used with a different request')
        return NextResponse.json({ error: mapped.error }, { status: mapped.status })
      }
    }

    const { data, error } = await admin.rpc('mark_barter_progress', {
      p_actor_user_id: requester.userId,
      p_agreement_id: agreementId,
      p_target_status: parsed.data.target_status,
      p_idempotency_key: parsed.data.idempotency_key ?? null,
    })

    if (error) {
      console.error('[barter.progress] RPC error', { userId: requester.userId, agreementId, error })
      const mapped = mapBarterRpcError(error.message)
      return NextResponse.json({ error: mapped.error }, { status: mapped.status })
    }

    // "Ready to exchange" only makes sense the moment the trade first
    // reaches 'preparing' -- the financial-readiness gate that unlocked
    // this specific transition (see mark_barter_progress()).
    if (parsed.data.target_status === 'preparing') {
      try {
        await notifyBarterParties(admin, agreementId, 'barter.ready_to_exchange', 'barter-ready-to-exchange')
      } catch (emailErr) {
        console.error('[barter.progress] email dispatch failed', { agreementId, emailErr })
      }
    }

    return NextResponse.json(data)
  } catch (err) {
    console.error('[barter.progress] unexpected error', { userId: requester.userId, agreementId, err })
    return NextResponse.json({ error: 'Could not update this trade — please try again' }, { status: 500 })
  }
}
