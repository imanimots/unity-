import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { adminEraseAccountRequestSchema } from '@/lib/privacy/validation'
import { addAdminNote } from '@/lib/admin/users-service'
import { eraseAccount, parseEraseAccountResult, describeBlockedCategories, mapAccountErasureRpcError, runPostErasureCleanup } from '@/lib/privacy/account-erasure'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/admin/users/[id]/erase — admin-assisted account erasure.
 * Mirrors the suspend/restrict/restore routes exactly. The erase_account()
 * RPC itself rejects an admin erasing their own account (p_actor_id =
 * p_user_id with request_source 'admin') — that path only exists for the
 * self-service route.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: userId } = await params
  if (!isValidUuid(userId)) {
    return NextResponse.json({ error: 'Invalid user id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:users:erase')
  if (!gate.ok) return gate.response

  let body: unknown
  try {
    body = await request.json()
  } catch {
    body = {}
  }
  const parsed = adminEraseAccountRequestSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'User storage is not configured' }, { status: 503 })
  }

  const { data, error } = await eraseAccount(admin, userId, gate.requester.userId, 'admin', parsed.data.idempotency_key)

  if (error) {
    console.error('[admin.users.erase] RPC error', { userId, error })
    const mapped = mapAccountErasureRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }

  const result = parseEraseAccountResult(data)
  if (result.blocked) {
    return NextResponse.json(
      {
        status: 'blocked',
        reasons: describeBlockedCategories(result.blockedCategories),
      },
      { status: 409 }
    )
  }

  await runPostErasureCleanup(admin, userId)

  if (parsed.data.internal_note) {
    await addAdminNote(admin, 'user', userId, gate.requester.userId, parsed.data.internal_note, undefined)
  }

  return NextResponse.json({ status: 'erased' })
}
