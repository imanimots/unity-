import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { listAdminDisputes } from '@/lib/admin/disputes-service'
import { csvResponse } from '@/lib/admin/csv'

/** GET /api/admin/disputes — real data, no mutating actions on this route. */
export async function GET(request: NextRequest) {
  const gate = await requireAdminForRoute(request, 'admin:disputes:list')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Dispute storage is not configured' }, { status: 503 })
  }

  const { searchParams } = new URL(request.url)
  const userIdParam = searchParams.get('userId')
  if (userIdParam && !isValidUuid(userIdParam)) {
    return NextResponse.json({ error: 'Invalid userId' }, { status: 400 })
  }
  const filters = {
    status: searchParams.get('status') ?? undefined,
    search: searchParams.get('search') ?? undefined,
    // Customer/Merchant 360 deep-link filter -- disputes this user raised or is a party to.
    participantUserId: userIdParam ?? undefined,
  }

  try {
    const disputes = await listAdminDisputes(admin, filters)

    if (searchParams.get('format') === 'csv') {
      return csvResponse(
        'disputes.csv',
        ['id', 'title', 'status', 'transactionType', 'transactionReference', 'raisedByName', 'assignedAdminName', 'outcome', 'createdAt', 'updatedAt'],
        disputes
      )
    }

    return NextResponse.json({ disputes })
  } catch (err) {
    console.error('[admin.disputes.list] error', err)
    return NextResponse.json({ error: 'Could not load disputes' }, { status: 500 })
  }
}
