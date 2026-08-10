import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient } from '@/lib/admin/route-helpers'
import { listAdminMarketplaceRequests } from '@/lib/admin/marketplace-requests-service'

/** GET /api/admin/marketplace-requests -- read-only list, narrow moderation surface (Step AE). */
export async function GET(request: NextRequest) {
  const gate = await requireAdminForRoute(request, 'admin:marketplace-requests:list')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) return NextResponse.json({ error: 'Marketplace storage is not configured' }, { status: 503 })

  const { searchParams } = new URL(request.url)
  try {
    const requests = await listAdminMarketplaceRequests(admin, {
      search: searchParams.get('search') ?? undefined,
      transactionType: searchParams.get('transaction_type') ?? undefined,
      status: searchParams.get('status') ?? undefined,
    })
    return NextResponse.json({ requests })
  } catch (err) {
    console.error('[admin.marketplace-requests.list] error', err)
    return NextResponse.json({ error: 'Could not load requests' }, { status: 500 })
  }
}
