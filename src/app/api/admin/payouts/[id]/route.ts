import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { getAdminPayoutDetail } from '@/lib/admin/payouts-service'

interface RouteParams {
  params: Promise<{ id: string }>
}

/** GET /api/admin/payouts/[id] -- real data, read-only detail. */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { id: payoutId } = await params
  if (!isValidUuid(payoutId)) {
    return NextResponse.json({ error: 'Invalid payout id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:payouts:detail')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Payout storage is not configured' }, { status: 503 })
  }

  try {
    const detail = await getAdminPayoutDetail(admin, payoutId)
    if (!detail) {
      return NextResponse.json({ error: 'Payout not found' }, { status: 404 })
    }
    return NextResponse.json(detail)
  } catch (err) {
    console.error('[admin.payouts.detail] error', { payoutId, err })
    return NextResponse.json({ error: 'Could not load payout' }, { status: 500 })
  }
}
