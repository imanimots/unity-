import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { getAdminEscrowDetail } from '@/lib/admin/escrow-service'

interface RouteParams {
  params: Promise<{ id: string }>
}

/** GET /api/admin/escrow/[id] -- read-only detail. */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { id: escrowId } = await params
  if (!isValidUuid(escrowId)) {
    return NextResponse.json({ error: 'Invalid escrow transaction id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:escrow:detail')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Escrow storage is not configured' }, { status: 503 })
  }

  try {
    const detail = await getAdminEscrowDetail(admin, escrowId)
    if (!detail) {
      return NextResponse.json({ error: 'Escrow transaction not found' }, { status: 404 })
    }
    return NextResponse.json(detail)
  } catch (err) {
    console.error('[admin.escrow.detail] error', { escrowId, err })
    return NextResponse.json({ error: 'Could not load escrow transaction' }, { status: 500 })
  }
}
