import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { getAdminUserDetail } from '@/lib/admin/users-service'

interface RouteParams {
  params: Promise<{ id: string }>
}

/** GET /api/admin/users/[id] — profile summary, verification summary, counts, history, notes. */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { id: userId } = await params
  if (!isValidUuid(userId)) {
    return NextResponse.json({ error: 'Invalid user id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:users:detail')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'User storage is not configured' }, { status: 503 })
  }

  try {
    const detail = await getAdminUserDetail(admin, userId)
    if (!detail) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }
    return NextResponse.json(detail)
  } catch (err) {
    console.error('[admin.users.detail] error', { userId, err })
    return NextResponse.json({ error: 'Could not load this user' }, { status: 500 })
  }
}
