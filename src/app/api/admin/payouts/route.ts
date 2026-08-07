import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient } from '@/lib/admin/route-helpers'
import { listAdminPayouts, ADMIN_PAYOUT_CSV_COLUMNS } from '@/lib/admin/payouts-service'
import { csvResponse } from '@/lib/admin/csv'

/** GET /api/admin/payouts -- real data, read-only list, no mutating actions on this route. */
export async function GET(request: NextRequest) {
  const gate = await requireAdminForRoute(request, 'admin:payouts:list')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Payout storage is not configured' }, { status: 503 })
  }

  const { searchParams } = new URL(request.url)
  const filters = {
    search: searchParams.get('search') ?? undefined,
    status: searchParams.get('status') ?? undefined,
    failedOnly: searchParams.get('failedOnly') === 'true',
    overdueOnly: searchParams.get('overdueOnly') === 'true',
    disputeRelated: searchParams.get('disputeRelated') === 'true',
    restrictedMerchant: searchParams.get('restrictedMerchant') === 'true',
    dateFrom: searchParams.get('dateFrom') ?? undefined,
    dateTo: searchParams.get('dateTo') ?? undefined,
  }

  try {
    const payouts = await listAdminPayouts(admin, filters)

    if (searchParams.get('format') === 'csv') {
      return csvResponse('merchant-payouts.csv', ADMIN_PAYOUT_CSV_COLUMNS, payouts)
    }

    return NextResponse.json({ payouts })
  } catch (err) {
    console.error('[admin.payouts.list] error', err)
    return NextResponse.json({ error: 'Could not load payouts' }, { status: 500 })
  }
}
