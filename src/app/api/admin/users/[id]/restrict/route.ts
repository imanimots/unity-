import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { accountStatusActionSchema } from '@/lib/admin/validation'
import { setUserAccountStatus } from '@/lib/admin/users-service'
import { mapAdminOperationsRpcError } from '@/lib/admin/rpc-errors'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/admin/users/[id]/restrict — may browse and view existing
 * records; cannot create new listings or bookings. See
 * src/lib/admin/account-status.ts for the exact behavior enforced.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: userId } = await params
  if (!isValidUuid(userId)) {
    return NextResponse.json({ error: 'Invalid user id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:users:restrict')
  if (!gate.ok) return gate.response

  let body: unknown
  try {
    body = await request.json()
  } catch {
    body = {}
  }
  const parsed = accountStatusActionSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'User storage is not configured' }, { status: 503 })
  }

  const { data, error } = await setUserAccountStatus(
    admin,
    userId,
    gate.requester.userId,
    'restricted',
    parsed.data.user_reason ?? null,
    parsed.data.internal_note ?? null,
    parsed.data.idempotency_key
  )

  if (error) {
    console.error('[admin.users.restrict] RPC error', { userId, error })
    const mapped = mapAdminOperationsRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }

  return NextResponse.json(data)
}
