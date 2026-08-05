import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { barterActionSchema } from '@/lib/barter/validation'
import { mapBarterRpcError } from '@/lib/barter/rpc-errors'
import { computeAcceptBarterOfferHash, checkIdempotentReplay } from '@/lib/barter/idempotency'
import { blockIfCannotTransact } from '@/lib/admin/account-status'
import { notifyBarterParties, notifyBarterParty } from '@/lib/barter/notify'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/barter/[id]/accept -- either party may accept, provided they
 * are NOT the one who proposed the current pending offer.
 * accept_barter_offer() snapshots accepted_offer_id (immutable from here),
 * locks every offered listing (via barter_locked_listings), auto-cancels
 * any other still-open proposal referencing a now-locked listing, and
 * (Step 11 Phase 4) creates 0-3 payment intents from the accepted
 * offer's own deposit/cash-adjustment terms -- creating an intent is a
 * plain DB insert, no provider call, so it's safe inside the same
 * transaction as acceptance. Authorizing/charging those intents is a
 * separate, explicit, payer-initiated action (POST .../deposit,
 * .../cash-adjustment).
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

  const rate = checkRateLimit(`barter:accept:${getClientKey(request)}`, 20, 60_000)
  if (!rate.allowed) {
    return NextResponse.json({ error: 'Too many requests — please slow down' }, { status: 429 })
  }

  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
  }
  const blocked = blockIfCannotTransact(requester.profile)
  if (blocked) return blocked

  let body: unknown
  try {
    body = await request.json()
  } catch {
    body = {}
  }
  const parsed = barterActionSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  try {
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    const admin = createServiceClient(url, serviceKey)
    const providerName = process.env.PAYMENT_PROVIDER || 'mock'

    if (parsed.data.idempotency_key) {
      const hash = computeAcceptBarterOfferHash(agreementId, providerName)
      const replay = await checkIdempotentReplay(admin, requester.userId, 'accept_barter_offer', parsed.data.idempotency_key, hash)
      if (replay.status === 'replay') return NextResponse.json(replay.result)
      if (replay.status === 'conflict') {
        const mapped = mapBarterRpcError('idempotency key already used with a different request')
        return NextResponse.json({ error: mapped.error }, { status: mapped.status })
      }
    }

    const { data, error } = await admin.rpc('accept_barter_offer', {
      p_actor_user_id: requester.userId,
      p_agreement_id: agreementId,
      p_provider: providerName,
      p_idempotency_key: parsed.data.idempotency_key ?? null,
    })

    if (error) {
      console.error('[barter.accept] RPC error', { userId: requester.userId, agreementId, error })
      const mapped = mapBarterRpcError(error.message)
      return NextResponse.json({ error: mapped.error }, { status: mapped.status })
    }

    try {
      await notifyBarterParties(admin, agreementId, 'barter.accepted', 'barter-accepted')

      const { data: agreement } = await admin.from('barter_agreements').select('party_a_id, party_b_id, accepted_offer_id').eq('id', agreementId).maybeSingle()
      if (agreement?.accepted_offer_id) {
        const { data: offer } = await admin
          .from('barter_offers')
          .select('deposit_required, deposit_payer, cash_adjustment_amount, cash_adjustment_payer')
          .eq('id', agreement.accepted_offer_id)
          .maybeSingle()
        if (offer?.deposit_required) {
          const payers = new Set<string>()
          if (offer.deposit_payer === 'party_a' || offer.deposit_payer === 'both') payers.add(agreement.party_a_id)
          if (offer.deposit_payer === 'party_b' || offer.deposit_payer === 'both') payers.add(agreement.party_b_id)
          for (const payerId of payers) {
            await notifyBarterParty(admin, agreementId, payerId, 'barter.deposit_required', 'barter-deposit-required')
          }
        }
      }
    } catch (emailErr) {
      console.error('[barter.accept] email dispatch failed', { agreementId, emailErr })
    }

    return NextResponse.json(data)
  } catch (err) {
    console.error('[barter.accept] unexpected error', { userId: requester.userId, agreementId, err })
    return NextResponse.json({ error: 'Could not accept this trade — please try again' }, { status: 500 })
  }
}
