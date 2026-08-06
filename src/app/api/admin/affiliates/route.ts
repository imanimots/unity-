import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient } from '@/lib/admin/route-helpers'
import { listAdminAffiliates } from '@/lib/admin/affiliate-service'

/** GET /api/admin/affiliates -- real data, read-only. */
export async function GET(request: NextRequest) {
  const gate = await requireAdminForRoute(request, 'admin:affiliates:list')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Affiliate storage is not configured' }, { status: 503 })
  }

  const { searchParams } = new URL(request.url)
  const filters = { search: searchParams.get('search') ?? undefined }

  try {
    const affiliates = await listAdminAffiliates(admin, filters)
    return NextResponse.json({ affiliates })
  } catch (err) {
    console.error('[admin.affiliates.list] error', err)
    return NextResponse.json({ error: 'Could not load affiliates' }, { status: 500 })
  }
}
