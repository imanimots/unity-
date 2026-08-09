import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/admin/escrow/[id]/release -- manual admin override. funded ->
 * released only, blocked while the underlying transaction has an
 * unresolved dispute (release_escrow_transaction() enforces this
 * server-side -- this route never bypasses it). A reason and the
 * released-to profile id are required.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: escrowId } = await params
  if (!isValidUuid(escrowId)) {
    return NextResponse.json({ error: 'Invalid escrow transaction id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:escrow:release')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Escrow storage is not configured' }, { status: 503 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  const { releasedTo, reason, idempotencyKey } = (body ?? {}) as { releasedTo?: string; reason?: string; idempotencyKey?: string }
  if (!releasedTo || !isValidUuid(releasedTo)) {
    return NextResponse.json({ error: 'A valid releasedTo profile id is required' }, { status: 400 })
  }
  if (!reason || !reason.trim()) {
    return NextResponse.json({ error: 'A reason is required' }, { status: 400 })
  }

  const adminId = gate.requester.userId

  const { data, error } = await admin.rpc('release_escrow_transaction', {
    p_actor_type: 'admin',
    p_actor_id: adminId,
    p_escrow_id: escrowId,
    p_released_to: releasedTo,
    p_reason: reason,
    p_idempotency_key: idempotencyKey ?? null,
  })

  if (error) {
    console.error('[admin.escrow.release] RPC error', { adminId, escrowId, error })
    return NextResponse.json({ error: error.message }, { status: 400 })
  }

  return NextResponse.json(data)
}
