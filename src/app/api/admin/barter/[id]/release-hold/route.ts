import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { adminSetBarterHoldSchema } from '@/lib/barter/validation'
import { mapBarterRpcError } from '@/lib/barter/rpc-errors'

interface RouteParams {
  params: Promise<{ id: string }>
}

/** POST /api/admin/barter/[id]/release-hold -- reopen a suspended agreement (Step 11 Phase 4 Part J). */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: agreementId } = await params
  if (!isValidUuid(agreementId)) {
    return NextResponse.json({ error: 'Invalid barter agreement id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:barter:release-hold')
  if (!gate.ok) return gate.response

  let body: unknown
  try {
    body = await request.json()
  } catch {
    body = {}
  }
  const parsed = adminSetBarterHoldSchema.omit({ hold: true }).safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Barter storage is not configured' }, { status: 503 })
  }

  const { data, error } = await admin.rpc('admin_set_barter_hold', {
    p_admin_id: gate.requester.userId,
    p_agreement_id: agreementId,
    p_hold: false,
    p_reason: parsed.data.reason ?? null,
    p_idempotency_key: parsed.data.idempotency_key ?? null,
  })

  if (error) {
    console.error('[admin.barter.release-hold] RPC error', { agreementId, error })
    const mapped = mapBarterRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }

  return NextResponse.json(data)
}
