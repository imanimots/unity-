import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { mapRentToBuyRpcError } from '@/lib/rent-to-buy/rpc-errors'
import { notifyRentToBuyParty } from '@/lib/rent-to-buy/notify'

interface RouteParams {
  params: Promise<{ id: string }>
}

/** POST .../mark-handed-over -- merchant-only, requires possession_eligible + at least one pre-handover evidence upload (Rule 5). */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'Invalid agreement id' }, { status: 400 })

  const requester = await getRequestProfile()
  if (!requester) return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return NextResponse.json({ error: 'Rent-to-buy storage is not configured' }, { status: 503 })
  const { createClient: createServiceClient } = await import('@supabase/supabase-js')
  const admin = createServiceClient(url, serviceKey)

  const { data, error } = await admin.rpc('mark_rent_to_buy_handed_over', { p_merchant_id: requester.userId, p_agreement_id: id, p_idempotency_key: null })
  if (error) {
    const mapped = mapRentToBuyRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }

  try {
    const { data: agreement } = await admin.from('rent_to_buy_agreements').select('customer_id').eq('id', id).maybeSingle()
    if (agreement) {
      await notifyRentToBuyParty(admin, id, agreement.customer_id, 'rent_to_buy.handed_over', 'rent-to-buy-handed-over', `rtb-handed-over-${id}`)
    }
  } catch (emailErr) {
    console.error('[rent-to-buy.mark-handed-over] email dispatch failed', { agreementId: id, emailErr })
  }

  return NextResponse.json(data)
}
