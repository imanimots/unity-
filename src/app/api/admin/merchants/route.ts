import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient } from '@/lib/admin/route-helpers'
import { listAdminMerchants } from '@/lib/admin/merchants-service'

/** GET /api/admin/merchants — real data, read-only monitoring, same role-scoped reuse of `profiles` as /api/admin/users. */
export async function GET(request: NextRequest) {
  const gate = await requireAdminForRoute(request, 'admin:merchants:list')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Merchant storage is not configured' }, { status: 503 })
  }

  const { searchParams } = new URL(request.url)
  const filters = {
    search: searchParams.get('search') ?? undefined,
    kycStatus: searchParams.get('kyc_status') ?? undefined,
    accountStatus: searchParams.get('account_status') ?? undefined,
  }

  try {
    const merchants = await listAdminMerchants(admin, filters)
    return NextResponse.json({ merchants })
  } catch (err) {
    console.error('[admin.merchants.list] error', err)
    return NextResponse.json({ error: 'Could not load merchants' }, { status: 500 })
  }
}
