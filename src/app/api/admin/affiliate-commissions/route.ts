import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient } from '@/lib/admin/route-helpers'
import { listAdminAffiliateCommissions, AFFILIATE_COMMISSION_CSV_COLUMNS } from '@/lib/admin/affiliate-service'
import { csvResponse } from '@/lib/admin/csv'

/** GET /api/admin/affiliate-commissions -- real data, read-only monitoring, no mutating actions on this route. */
export async function GET(request: NextRequest) {
  const gate = await requireAdminForRoute(request, 'admin:affiliate-commissions:list')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Affiliate storage is not configured' }, { status: 503 })
  }

  const { searchParams } = new URL(request.url)
  const filters = {
    affiliateId: searchParams.get('affiliateId') ?? undefined,
    merchantId: searchParams.get('merchantId') ?? undefined,
    listingId: searchParams.get('listingId') ?? undefined,
    transactionType: searchParams.get('transactionType') ?? undefined,
    status: searchParams.get('status') ?? undefined,
    search: searchParams.get('search') ?? undefined,
  }

  try {
    const commissions = await listAdminAffiliateCommissions(admin, filters)

    if (searchParams.get('format') === 'csv') {
      return csvResponse('affiliate-commissions.csv', AFFILIATE_COMMISSION_CSV_COLUMNS, commissions)
    }

    return NextResponse.json({ commissions })
  } catch (err) {
    console.error('[admin.affiliate-commissions.list] error', err)
    return NextResponse.json({ error: 'Could not load affiliate commissions' }, { status: 500 })
  }
}
