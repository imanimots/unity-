import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { adminSetBarterHoldSchema } from '@/lib/barter/validation'
import { mapBarterRpcError } from '@/lib/barter/rpc-errors'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/admin/barter/[id]/hold -- suspend an agreement (Step 11
 * Phase 4 Part J). Sets the same admin_hold/admin_hold_reason columns
 * every Phase A barter RPC already checks (accept/counter/reject) --
 * previously unset by anything. See .../release-hold for reopening.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: agreementId } = await params
  if (!isValidUuid(agreementId)) {
    return NextResponse.json({ error: 'Invalid barter agreement id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:barter:hold')
  if (!gate.ok) return gate.response

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
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
    p_hold: true,
    p_reason: parsed.data.reason ?? null,
    p_idempotency_key: parsed.data.idempotency_key ?? null,
  })

  if (error) {
    console.error('[admin.barter.hold] RPC error', { agreementId, error })
    const mapped = mapBarterRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }

  return NextResponse.json(data)
}
