import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { getAdminDisputeDetail } from '@/lib/admin/disputes-service'

interface RouteParams {
  params: Promise<{ id: string }>
}

/** GET /api/admin/disputes/[id] — full detail: dispute row, history, evidence. */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { id: disputeId } = await params
  if (!isValidUuid(disputeId)) {
    return NextResponse.json({ error: 'Invalid dispute id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:disputes:detail')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Dispute storage is not configured' }, { status: 503 })
  }

  const detail = await getAdminDisputeDetail(admin, disputeId)
  if (!detail) {
    return NextResponse.json({ error: 'Dispute not found' }, { status: 404 })
  }

  return NextResponse.json(detail)
}
