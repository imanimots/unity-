import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { getAdminSubscriptionDetail } from '@/lib/admin/subscriptions-service'

interface RouteParams {
  params: Promise<{ merchantId: string }>
}

/** GET /api/admin/subscriptions/[merchantId] -- real data, read-only detail. Resolves any merchant id, including one with no subscription row (implicit Starter). */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { merchantId } = await params
  if (!isValidUuid(merchantId)) {
    return NextResponse.json({ error: 'Invalid merchant id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:subscriptions:detail')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Subscription storage is not configured' }, { status: 503 })
  }

  try {
    const detail = await getAdminSubscriptionDetail(admin, merchantId)
    if (!detail) {
      return NextResponse.json({ error: 'Merchant not found' }, { status: 404 })
    }
    return NextResponse.json(detail)
  } catch (err) {
    console.error('[admin.subscriptions.detail] error', { merchantId, err })
    return NextResponse.json({ error: 'Could not load subscription' }, { status: 500 })
  }
}
