import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { adminCommissionOverrideSchema } from '@/lib/commissions/validation'
import { mapCommissionRpcError } from '@/lib/commissions/rpc-errors'
import { computeCommissionIdAndReasonHash, checkIdempotentReplay } from '@/lib/commissions/idempotency'

interface RouteParams {
  params: Promise<{ id: string }>
}

/** POST /api/admin/commissions/[id]/hold -- a manual admin hold (separate from the automatic dispute-driven hold). Reason mandatory. */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: commissionId } = await params
  if (!isValidUuid(commissionId)) {
    return NextResponse.json({ error: 'Invalid commission id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:commissions:hold')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Commission storage is not configured' }, { status: 503 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  const parsed = adminCommissionOverrideSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'A reason is required', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const adminId = gate.requester.userId

  if (parsed.data.idempotency_key) {
    const hash = computeCommissionIdAndReasonHash(commissionId, parsed.data.reason)
    const replay = await checkIdempotentReplay(admin, adminId, 'hold_unity_commission', parsed.data.idempotency_key, hash)
    if (replay.status === 'replay') return NextResponse.json(replay.result)
    if (replay.status === 'conflict') {
      const mapped = mapCommissionRpcError('idempotency key already used with a different request')
      return NextResponse.json({ error: mapped.error }, { status: mapped.status })
    }
  }

  const { data, error } = await admin.rpc('hold_unity_commission', {
    p_actor_type: 'admin',
    p_actor_id: adminId,
    p_commission_id: commissionId,
    p_reason: parsed.data.reason,
    p_idempotency_key: parsed.data.idempotency_key ?? null,
  })

  if (error) {
    console.error('[admin.commissions.hold] RPC error', { adminId, commissionId, error })
    const mapped = mapCommissionRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }

  return NextResponse.json(data)
}
