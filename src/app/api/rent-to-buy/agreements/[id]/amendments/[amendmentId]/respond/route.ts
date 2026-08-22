import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { rentToBuyAmendmentRespondSchema } from '@/lib/rent-to-buy/validation'
import { mapRentToBuyRpcError } from '@/lib/rent-to-buy/rpc-errors'
import { notifyRentToBuyParty } from '@/lib/rent-to-buy/notify'

interface RouteParams {
  params: Promise<{ id: string; amendmentId: string }>
}

/** POST .../amendments/[amendmentId]/respond -- the non-proposing party accepts or declines (Rule 21). */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id, amendmentId } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[0-9a-f-]{36}$/i.test(amendmentId)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  }

  const requester = await getRequestProfile()
  if (!requester) return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })

  let body: unknown
  try { body = await request.json() } catch { body = {} }
  const parsed = rentToBuyAmendmentRespondSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid response', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return NextResponse.json({ error: 'Rent-to-buy storage is not configured' }, { status: 503 })
  const { createClient: createServiceClient } = await import('@supabase/supabase-js')
  const admin = createServiceClient(url, serviceKey)

  const { data, error } = await admin.rpc('respond_rent_to_buy_amendment', {
    p_actor_user_id: requester.userId, p_amendment_id: amendmentId, p_accept: parsed.data.accept, p_decline_reason: parsed.data.decline_reason ?? null, p_idempotency_key: parsed.data.idempotency_key ?? null,
  })
  if (error) {
    const mapped = mapRentToBuyRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }

  try {
    const { data: agreement } = await admin.from('rent_to_buy_agreements').select('merchant_id, customer_id').eq('id', id).maybeSingle()
    if (agreement) {
      const recipientId = requester.userId === agreement.merchant_id ? agreement.customer_id : agreement.merchant_id
      const eventSuffix = parsed.data.accept ? 'accepted' : 'declined'
      await notifyRentToBuyParty(admin, id, recipientId, `rent_to_buy.amendment_${eventSuffix}`, `rent-to-buy-amendment-${eventSuffix}`, `rtb-amendment-${eventSuffix}-${amendmentId}`)
    }
  } catch (emailErr) {
    console.error('[rent-to-buy.amendments.respond] email dispatch failed', { agreementId: id, amendmentId, emailErr })
  }

  return NextResponse.json(data)
}
