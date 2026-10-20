import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { getAdminServiceClient } from '@/lib/admin/route-helpers'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { eraseAccountRequestSchema } from '@/lib/privacy/validation'
import { eraseAccount, parseEraseAccountResult, describeBlockedCategories, mapAccountErasureRpcError, runPostErasureCleanup } from '@/lib/privacy/account-erasure'

/**
 * POST /api/account/erase — self-service account erasure. The target user
 * is always the authenticated session user, derived server-side via
 * getRequestProfile() — never taken from the request body, so there is no
 * possible IDOR against another account via this route.
 */
export async function POST(request: NextRequest) {
  const rate = await checkRateLimit(`account:erase:${getClientKey(request)}`, 5, 60_000)
  if (!rate.allowed) {
    return NextResponse.json({ error: 'Too many requests — please slow down' }, { status: 429 })
  }

  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    body = {}
  }
  const parsed = eraseAccountRequestSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Account storage is not configured' }, { status: 503 })
  }

  const { data, error } = await eraseAccount(admin, requester.userId, requester.userId, 'self_service', parsed.data.idempotency_key)

  if (error) {
    console.error('[account.erase] RPC error', { error })
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

  const cleanup = await runPostErasureCleanup(admin, requester.userId)

  return NextResponse.json({
    status: 'erased',
    cleanup_status: cleanup.complete ? 'complete' : 'pending',
    ...(cleanup.complete ? {} : { pending_cleanup: cleanup.pending }),
  })
}
