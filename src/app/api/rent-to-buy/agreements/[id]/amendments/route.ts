import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { rentToBuyAmendmentProposeSchema } from '@/lib/rent-to-buy/validation'
import { mapRentToBuyRpcError } from '@/lib/rent-to-buy/rpc-errors'
import { computeAmendmentProposeHash, checkIdempotentReplay } from '@/lib/rent-to-buy/idempotency'
import { notifyRentToBuyParty } from '@/lib/rent-to-buy/notify'

interface RouteParams {
  params: Promise<{ id: string }>
}

/** POST .../amendments -- propose a bilateral amendment (Rule 21). The other party must explicitly accept via .../amendments/[amendmentId]/respond. */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'Invalid agreement id' }, { status: 400 })

  const requester = await getRequestProfile()
  if (!requester) return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })

  let body: unknown
  try { body = await request.json() } catch { body = {} }
  const parsed = rentToBuyAmendmentProposeSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid amendment proposal', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return NextResponse.json({ error: 'Rent-to-buy storage is not configured' }, { status: 503 })
  const { createClient: createServiceClient } = await import('@supabase/supabase-js')
  const admin = createServiceClient(url, serviceKey)

  if (parsed.data.idempotency_key) {
    const hash = computeAmendmentProposeHash(id, parsed.data.proposed_changes)
    const replay = await checkIdempotentReplay(admin, requester.userId, 'propose_rent_to_buy_amendment', parsed.data.idempotency_key, hash)
    if (replay.status === 'replay') return NextResponse.json(replay.result, { status: 201 })
    if (replay.status === 'conflict') {
      return NextResponse.json({ error: 'This request was already submitted with different data. Please refresh and try again.' }, { status: 409 })
    }
  }

  const { data, error } = await admin.rpc('propose_rent_to_buy_amendment', {
    p_actor_user_id: requester.userId, p_agreement_id: id, p_proposed_changes: parsed.data.proposed_changes, p_reason: parsed.data.reason ?? null, p_idempotency_key: null,
  })
  if (error) {
    const mapped = mapRentToBuyRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }

  if (parsed.data.idempotency_key) {
    const hash = computeAmendmentProposeHash(id, parsed.data.proposed_changes)
    await admin.from('idempotency_keys').insert({ merchant_id: requester.userId, operation: 'propose_rent_to_buy_amendment', idempotency_key: parsed.data.idempotency_key, request_hash: hash, result: data })
  }

  try {
    const { data: agreement } = await admin.from('rent_to_buy_agreements').select('merchant_id, customer_id').eq('id', id).maybeSingle()
    if (agreement) {
      const recipientId = requester.userId === agreement.merchant_id ? agreement.customer_id : agreement.merchant_id
      await notifyRentToBuyParty(admin, id, recipientId, 'rent_to_buy.amendment_proposed', 'rent-to-buy-amendment-proposed', `rtb-amendment-proposed-${data.amendment_id}`)
    }
  } catch (emailErr) {
    console.error('[rent-to-buy.amendments] email dispatch failed', { agreementId: id, emailErr })
  }

  return NextResponse.json(data, { status: 201 })
}
