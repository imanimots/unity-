import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient } from '@/lib/admin/route-helpers'
import { listAdminUnityCommissions, UNITY_COMMISSION_CSV_COLUMNS } from '@/lib/admin/commissions-service'
import { csvResponse } from '@/lib/admin/csv'

/** GET /api/admin/commissions -- real data, read-only monitoring, no mutating actions on this route. */
export async function GET(request: NextRequest) {
  const gate = await requireAdminForRoute(request, 'admin:commissions:list')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Commission storage is not configured' }, { status: 503 })
  }

  const { searchParams } = new URL(request.url)
  const filters = {
    merchantId: searchParams.get('merchantId') ?? undefined,
    listingId: searchParams.get('listingId') ?? undefined,
    transactionType: searchParams.get('transactionType') ?? undefined,
    status: searchParams.get('status') ?? undefined,
    search: searchParams.get('search') ?? undefined,
  }

  try {
    const commissions = await listAdminUnityCommissions(admin, filters)

    if (searchParams.get('format') === 'csv') {
      return csvResponse('unity-commissions.csv', UNITY_COMMISSION_CSV_COLUMNS, commissions)
    }

    return NextResponse.json({ commissions })
  } catch (err) {
    console.error('[admin.commissions.list] error', err)
    return NextResponse.json({ error: 'Could not load commissions' }, { status: 500 })
  }
}
