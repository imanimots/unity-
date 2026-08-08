import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient } from '@/lib/admin/route-helpers'
import { listAdminSubscriptions, SUBSCRIPTION_CSV_COLUMNS } from '@/lib/admin/subscriptions-service'
import { csvResponse } from '@/lib/admin/csv'
import { triggerMerchantSubscriptionLazySweep } from '@/lib/subscriptions/lazy-expiry'

/** GET /api/admin/subscriptions -- real data, read-only list, no mutating actions on this route. */
export async function GET(request: NextRequest) {
  const gate = await requireAdminForRoute(request, 'admin:subscriptions:list')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Subscription storage is not configured' }, { status: 503 })
  }

  await triggerMerchantSubscriptionLazySweep(admin)

  const { searchParams } = new URL(request.url)
  const filters = {
    search: searchParams.get('search') ?? undefined,
    status: searchParams.get('status') ?? undefined,
    planId: searchParams.get('planId') ?? undefined,
  }

  try {
    const subscriptions = await listAdminSubscriptions(admin, filters)

    if (searchParams.get('format') === 'csv') {
      return csvResponse('merchant-subscriptions.csv', SUBSCRIPTION_CSV_COLUMNS, subscriptions)
    }

    return NextResponse.json({ subscriptions })
  } catch (err) {
    console.error('[admin.subscriptions.list] error', err)
    return NextResponse.json({ error: 'Could not load subscriptions' }, { status: 500 })
  }
}
