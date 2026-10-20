import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { runPostErasureCleanup } from '@/lib/privacy/account-erasure'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/admin/users/[id]/retry-cleanup — admin-triggered retry of
 * post-erasure external cleanup (auth ban, avatar/KYC storage deletion)
 * for an account that is ALREADY erased. Deliberately does NOT call
 * erase_account() again — it only re-attempts whichever cleanup
 * categories account_erasure_cleanup still records as incomplete, never
 * re-validates obligations, never re-runs any other account mutation, and
 * never touches financial/legal history. Takes no body at all, so there is
 * no client-supplied path/category to target — every storage prefix
 * runPostErasureCleanup touches is derived entirely from the server-side
 * `userId` path param, which is itself validated as a real, already-erased
 * account below before any cleanup is attempted.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: userId } = await params
  if (!isValidUuid(userId)) {
    return NextResponse.json({ error: 'Invalid user id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:users:retry-cleanup')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'User storage is not configured' }, { status: 503 })
  }

  const { data: profile, error: profileError } = await admin
    .from('profiles')
    .select('id, account_status')
    .eq('id', userId)
    .maybeSingle()

  if (profileError) {
    console.error('[admin.users.retry-cleanup] profile lookup error', { userId, profileError })
    return NextResponse.json({ error: 'Could not look up this account' }, { status: 500 })
  }
  if (!profile) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }
  if (profile.account_status !== 'erased') {
    return NextResponse.json({ error: 'This account has not been erased — nothing to retry' }, { status: 409 })
  }

  const cleanup = await runPostErasureCleanup(admin, userId)

  return NextResponse.json({
    cleanup_status: cleanup.complete ? 'complete' : 'pending',
    ...(cleanup.complete ? {} : { pending_cleanup: cleanup.pending }),
  })
}
