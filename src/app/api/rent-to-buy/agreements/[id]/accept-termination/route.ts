import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { rentToBuyActionSchema } from '@/lib/rent-to-buy/validation'
import { mapRentToBuyRpcError } from '@/lib/rent-to-buy/rpc-errors'
import { notifyRentToBuyParty } from '@/lib/rent-to-buy/notify'

interface RouteParams {
  params: Promise<{ id: string }>
}

/** POST .../accept-termination -- the non-proposing party accepts, ending the agreement by mutual agreement (Rule 19/20). */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'Invalid agreement id' }, { status: 400 })

  const requester = await getRequestProfile()
  if (!requester) return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })

  let body: unknown
  try { body = await request.json() } catch { body = {} }
  const parsed = rentToBuyActionSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return NextResponse.json({ error: 'Rent-to-buy storage is not configured' }, { status: 503 })
  const { createClient: createServiceClient } = await import('@supabase/supabase-js')
  const admin = createServiceClient(url, serviceKey)

  const { data, error } = await admin.rpc('accept_rent_to_buy_mutual_termination', {
    p_actor_user_id: requester.userId, p_agreement_id: id, p_idempotency_key: parsed.data.idempotency_key ?? null,
  })
  if (error) {
    const mapped = mapRentToBuyRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }

  try {
    const { data: agreement } = await admin.from('rent_to_buy_agreements').select('merchant_id, customer_id').eq('id', id).maybeSingle()
    if (agreement) {
      const recipientId = requester.userId === agreement.merchant_id ? agreement.customer_id : agreement.merchant_id
      await notifyRentToBuyParty(admin, id, recipientId, 'rent_to_buy.terminated', 'rent-to-buy-terminated', `rtb-terminated-${id}`)
    }
  } catch (emailErr) {
    console.error('[rent-to-buy.accept-termination] email dispatch failed', { agreementId: id, emailErr })
  }

  return NextResponse.json(data)
}
