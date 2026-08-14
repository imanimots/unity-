import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { counterBarterOfferSchema } from '@/lib/barter/validation'
import { mapBarterRpcError } from '@/lib/barter/rpc-errors'
import { computeCounterBarterOfferHash, checkIdempotentReplay } from '@/lib/barter/idempotency'
import { BARTER_PROPOSAL_EXPIRY_HOURS } from '@/lib/barter/proposal-expiry'
import { blockIfCannotCreate } from '@/lib/admin/account-status'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/barter/[id]/counter -- either party may counter, provided
 * they are NOT the one who proposed the current pending offer.
 * counter_barter_offer() derives which side the caller is on from the
 * agreement row itself, and enforces the "not your turn" rule -- see the
 * RPC's own comment. Each counter is a complete replacement package, not
 * a partial patch, and resets the response deadline to a fresh window.
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

  const rate = checkRateLimit(`barter:counter:${getClientKey(request)}`, 20, 60_000)
  if (!rate.allowed) {
    return NextResponse.json({ error: 'Too many requests — please slow down' }, { status: 429 })
  }

  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
  }
  const blocked = blockIfCannotCreate(requester.profile)
  if (blocked) return blocked

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const parsed = counterBarterOfferSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid counter-offer', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  try {
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    const admin = createServiceClient(url, serviceKey)

    if (parsed.data.idempotency_key) {
      const hash = computeCounterBarterOfferHash(agreementId, {
        partyAListingIds: parsed.data.party_a_listing_ids,
        partyBListingIds: parsed.data.party_b_listing_ids,
        partyAContributions: parsed.data.party_a_contributions,
        partyBContributions: parsed.data.party_b_contributions,
        depositTerms: parsed.data.deposit_terms,
        cashAdjustmentAmount: parsed.data.cash_adjustment_amount ?? 0,
        deliveryMethod: parsed.data.delivery_method,
        depositAmount: parsed.data.deposit_amount,
        depositPayer: parsed.data.deposit_payer,
        message: parsed.data.message,
      })
      const replay = await checkIdempotentReplay(admin, requester.userId, 'counter_barter_offer', parsed.data.idempotency_key, hash)
      if (replay.status === 'replay') return NextResponse.json(replay.result)
      if (replay.status === 'conflict') {
        const mapped = mapBarterRpcError('idempotency key already used with a different request')
        return NextResponse.json({ error: mapped.error }, { status: mapped.status })
      }
    }

    const { data, error } = await admin.rpc('counter_barter_offer', {
      p_actor_user_id: requester.userId,
      p_agreement_id: agreementId,
      p_party_a_listing_ids: parsed.data.party_a_listing_ids,
      p_party_b_listing_ids: parsed.data.party_b_listing_ids,
      p_cash_adjustment_amount: parsed.data.cash_adjustment_amount ?? 0,
      p_cash_adjustment_payer: parsed.data.cash_adjustment_payer ?? null,
      p_delivery_method: parsed.data.delivery_method,
      p_delivery_notes: parsed.data.delivery_notes ?? null,
      p_delivery_responsibility: parsed.data.delivery_responsibility ?? null,
      p_deposit_required: parsed.data.deposit_required ?? false,
      p_deposit_amount: parsed.data.deposit_amount ?? null,
      p_deposit_currency: parsed.data.deposit_currency ?? 'ZAR',
      p_deposit_payer: parsed.data.deposit_payer ?? null,
      p_message: parsed.data.message ?? null,
      p_expiry_hours: BARTER_PROPOSAL_EXPIRY_HOURS,
      p_idempotency_key: parsed.data.idempotency_key ?? null,
      p_party_a_contributions: parsed.data.party_a_contributions ?? null,
      p_party_b_contributions: parsed.data.party_b_contributions ?? null,
      p_deposit_terms: parsed.data.deposit_terms ?? null,
    })

    if (error) {
      console.error('[barter.counter] RPC error', { userId: requester.userId, agreementId, error })
      const mapped = mapBarterRpcError(error.message)
      return NextResponse.json({ error: mapped.error }, { status: mapped.status })
    }

    return NextResponse.json(data)
  } catch (err) {
    console.error('[barter.counter] unexpected error', { userId: requester.userId, agreementId, err })
    return NextResponse.json({ error: 'Could not submit your counter-offer — please try again' }, { status: 500 })
  }
}
