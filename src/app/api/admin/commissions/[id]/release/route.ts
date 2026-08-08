import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { mapCommissionRpcError } from '@/lib/commissions/rpc-errors'
import { computeCommissionIdOnlyHash, checkIdempotentReplay } from '@/lib/commissions/idempotency'

interface RouteParams {
  params: Promise<{ id: string }>
}

/** POST /api/admin/commissions/[id]/release -- held -> pending. No reason required (this reverses a hold, it doesn't create a new financial fact). */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: commissionId } = await params
  if (!isValidUuid(commissionId)) {
    return NextResponse.json({ error: 'Invalid commission id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:commissions:release')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Commission storage is not configured' }, { status: 503 })
  }

  let body: unknown = {}
  try {
    body = await request.json()
  } catch {
    body = {}
  }
  const idempotencyKey = typeof (body as { idempotency_key?: unknown })?.idempotency_key === 'string' ? (body as { idempotency_key: string }).idempotency_key : undefined

  const adminId = gate.requester.userId

  if (idempotencyKey) {
    const hash = computeCommissionIdOnlyHash(commissionId)
    const replay = await checkIdempotentReplay(admin, adminId, 'release_unity_commission_hold', idempotencyKey, hash)
    if (replay.status === 'replay') return NextResponse.json(replay.result)
    if (replay.status === 'conflict') {
      const mapped = mapCommissionRpcError('idempotency key already used with a different request')
      return NextResponse.json({ error: mapped.error }, { status: mapped.status })
    }
  }

  const { data, error } = await admin.rpc('release_unity_commission_hold', {
    p_actor_type: 'admin',
    p_actor_id: adminId,
    p_commission_id: commissionId,
    p_idempotency_key: idempotencyKey ?? null,
  })

  if (error) {
    console.error('[admin.commissions.release] RPC error', { adminId, commissionId, error })
    const mapped = mapCommissionRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }

  return NextResponse.json(data)
}
