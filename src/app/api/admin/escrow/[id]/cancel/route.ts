import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/admin/escrow/[id]/cancel -- manual admin override. pending ->
 * cancelled only (a never-funded escrow row -- nothing was ever
 * attempted with a provider). A reason is required.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: escrowId } = await params
  if (!isValidUuid(escrowId)) {
    return NextResponse.json({ error: 'Invalid escrow transaction id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:escrow:cancel')
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
  const { reason, idempotencyKey } = (body ?? {}) as { reason?: string; idempotencyKey?: string }
  if (!reason || !reason.trim()) {
    return NextResponse.json({ error: 'A reason is required' }, { status: 400 })
  }

  const adminId = gate.requester.userId

  const { data, error } = await admin.rpc('cancel_escrow_transaction', {
    p_admin_id: adminId,
    p_escrow_id: escrowId,
    p_reason: reason,
    p_idempotency_key: idempotencyKey ?? null,
  })

  if (error) {
    console.error('[admin.escrow.cancel] RPC error', { adminId, escrowId, error })
    return NextResponse.json({ error: error.message }, { status: 400 })
  }

  return NextResponse.json(data)
}
