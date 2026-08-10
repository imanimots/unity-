import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient } from '@/lib/admin/route-helpers'
import { rentToBuyDefaultSchema } from '@/lib/rent-to-buy/validation'
import { mapRentToBuyRpcError } from '@/lib/rent-to-buy/rpc-errors'
import { notifyRentToBuyParty } from '@/lib/rent-to-buy/notify'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/admin/rent-to-buy/[id]/default -- the ONLY path that can
 * mark an agreement defaulted. Explicit, admin-triggered, manual (Rule
 * 10/11 -- no automatic grace-period/missed-payment-count timing exists
 * anywhere in this codebase; that policy REQUIRES BUSINESS APPROVAL).
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'Invalid agreement id' }, { status: 400 })

  const gate = await requireAdminForRoute(request, 'admin:rtb:default')
  if (!gate.ok) return gate.response

  let body: unknown
  try { body = await request.json() } catch { body = {} }
  const parsed = rentToBuyDefaultSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'A reason is required', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })

  const admin = await getAdminServiceClient()
  if (!admin) return NextResponse.json({ error: 'Rent-to-buy storage is not configured' }, { status: 503 })

  const { data, error } = await admin.rpc('mark_rent_to_buy_agreement_defaulted', {
    p_admin_id: gate.requester.userId, p_agreement_id: id, p_reason: parsed.data.reason, p_idempotency_key: null,
  })
  if (error) {
    const mapped = mapRentToBuyRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }

  try {
    const { data: agreement } = await admin.from('rent_to_buy_agreements').select('customer_id').eq('id', id).maybeSingle()
    if (agreement) {
      await notifyRentToBuyParty(admin, id, agreement.customer_id, 'rent_to_buy.defaulted', 'rent-to-buy-defaulted', `rtb-defaulted-${id}`)
    }
  } catch (emailErr) {
    console.error('[admin.rent-to-buy.default] email dispatch failed', { agreementId: id, emailErr })
  }

  return NextResponse.json(data)
}
