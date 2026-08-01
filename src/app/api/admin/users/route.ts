import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient } from '@/lib/admin/route-helpers'
import { listAdminUsers } from '@/lib/admin/users-service'
import { csvResponse } from '@/lib/admin/csv'

/**
 * GET /api/admin/users — search + filter, real Supabase data. Never
 * selects ID/passport document fields; those stay behind the dedicated
 * verification review page (Step 4).
 */
export async function GET(request: NextRequest) {
  const gate = await requireAdminForRoute(request, 'admin:users:list')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'User storage is not configured' }, { status: 503 })
  }

  const { searchParams } = new URL(request.url)
  const filters = {
    search: searchParams.get('search') ?? undefined,
    role: searchParams.get('role') ?? undefined,
    kycStatus: searchParams.get('kyc_status') ?? undefined,
    accountStatus: searchParams.get('account_status') ?? undefined,
  }

  try {
    const users = await listAdminUsers(admin, filters)

    if (searchParams.get('format') === 'csv') {
      return csvResponse(
        'users.csv',
        ['id', 'fullName', 'displayName', 'role', 'kycStatus', 'accountStatus', 'unityScore', 'createdAt'],
        users
      )
    }

    return NextResponse.json({ users })
  } catch (err) {
    console.error('[admin.users.list] error', err)
    return NextResponse.json({ error: 'Could not load users' }, { status: 500 })
  }
}
