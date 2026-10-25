import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { getAdminAuthInfoRespectingErasure } from '@/lib/supabase/admin-auth-info'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * GET /api/admin/users/[id]/auth-info — the Customer 360 "Auth & Access"
 * panel, read-only. A separate, lazily-fetched route (not folded into
 * GET /api/admin/users/[id]) so the main profile detail stays fast and
 * this one Admin Auth API round trip only happens when the panel is
 * actually opened.
 *
 * `profiles.id` is always the same uuid as `auth.users.id` (every
 * signup path creates both rows with the same id) -- so the path param
 * doubles as the auth user id here, no extra lookup needed for identity
 * resolution.
 *
 * ADMIN-CONTROL-CENTRE-BATCH-A1-P1-REMEDIATION: this route is the one
 * shared call site both /admin/users/[id] (Customer 360) and
 * /admin/merchants/[id] (Merchant 360) hit for this panel -- fixing
 * erasure-awareness here, server-side, automatically covers both.
 * A cheap `account_status` lookup runs BEFORE any Admin Auth API call,
 * and `getAdminAuthInfoRespectingErasure` is the only function allowed
 * to decide whether that call happens at all -- for an erased profile it
 * never does, so the original email/phone are never fetched, never held
 * in memory for this request, and never present in the JSON below.
 *
 * Never mutates anything. ADMIN-CONTROL-CENTRE-BATCH-A1 deliberately
 * ships this read-only; send-recovery/resend-verification/revoke-
 * sessions are deferred to the security batch (see design report §6).
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { id: userId } = await params
  if (!isValidUuid(userId)) {
    return NextResponse.json({ error: 'Invalid user id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:users:auth-info')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Auth storage is not configured' }, { status: 503 })
  }

  try {
    const { data: profile, error: profileError } = await admin.from('profiles').select('account_status').eq('id', userId).maybeSingle()
    if (profileError) throw profileError

    const isErased = profile?.account_status === 'erased'
    const info = await getAdminAuthInfoRespectingErasure(admin, userId, isErased)
    if (!info) {
      return NextResponse.json({ authUserExists: false })
    }
    return NextResponse.json(info)
  } catch (err) {
    console.error('[admin.users.auth-info] error', { userId, err })
    return NextResponse.json({ error: 'Could not load auth/access information' }, { status: 500 })
  }
}
