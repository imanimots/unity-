import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient } from '@/lib/admin/route-helpers'
import { listAdminBarterAgreements } from '@/lib/admin/barter-service'
import { csvResponse } from '@/lib/admin/csv'

/** GET /api/admin/barter -- real data, no mutating actions on this route. */
export async function GET(request: NextRequest) {
  const gate = await requireAdminForRoute(request, 'admin:barter:list')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Barter storage is not configured' }, { status: 503 })
  }

  const { searchParams } = new URL(request.url)
  const filters = { status: searchParams.get('status') ?? undefined, search: searchParams.get('search') ?? undefined }

  try {
    const agreements = await listAdminBarterAgreements(admin, filters)

    if (searchParams.get('format') === 'csv') {
      return csvResponse(
        'barter-agreements.csv',
        ['id', 'agreementReference', 'status', 'partyAName', 'partyBName', 'anchorListingTitle', 'adminHold', 'createdAt', 'updatedAt'],
        agreements
      )
    }

    return NextResponse.json({ agreements })
  } catch (err) {
    console.error('[admin.barter.list] error', err)
    return NextResponse.json({ error: 'Could not load barter agreements' }, { status: 500 })
  }
}
