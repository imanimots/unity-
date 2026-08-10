import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient } from '@/lib/admin/route-helpers'
import { mapRentToBuyRpcError } from '@/lib/rent-to-buy/rpc-errors'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/admin/rent-to-buy/[id]/create-recovery-case -- the ONLY
 * path that can ever create a recovery case (Rule 6/K -- no software
 * authority to seize property; a trusted admin action is the sole
 * escalation route). recovery_provider is hard-set to 'manual' by the
 * RPC itself -- no real recovery-partner integration exists anywhere.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'Invalid agreement id' }, { status: 400 })

  const gate = await requireAdminForRoute(request, 'admin:rtb:recovery-case')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) return NextResponse.json({ error: 'Rent-to-buy storage is not configured' }, { status: 503 })

  const { data, error } = await admin.rpc('create_rent_to_buy_recovery_case', { p_admin_id: gate.requester.userId, p_agreement_id: id, p_idempotency_key: null })
  if (error) {
    const mapped = mapRentToBuyRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }
  return NextResponse.json(data)
}
