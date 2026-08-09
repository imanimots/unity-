import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { refundEscrowTransaction } from '@/lib/escrow/orchestrator'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/admin/escrow/[id]/refund -- manual admin override. funded ->
 * refunded/partially_refunded. Never blocked by an unresolved dispute
 * (returning money to the payer is the safe direction). A reason and a
 * positive amount are required.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: escrowId } = await params
  if (!isValidUuid(escrowId)) {
    return NextResponse.json({ error: 'Invalid escrow transaction id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:escrow:refund')
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
  const { amount, reason } = (body ?? {}) as { amount?: number; reason?: string }
  if (typeof amount !== 'number' || amount <= 0) {
    return NextResponse.json({ error: 'A positive refund amount is required' }, { status: 400 })
  }
  if (!reason || !reason.trim()) {
    return NextResponse.json({ error: 'A reason is required' }, { status: 400 })
  }

  const adminId = gate.requester.userId

  try {
    const result = await refundEscrowTransaction(admin, escrowId, adminId, amount, reason)
    return NextResponse.json(result)
  } catch (err) {
    console.error('[admin.escrow.refund] error', { adminId, escrowId, err })
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Could not refund escrow transaction' }, { status: 400 })
  }
}
