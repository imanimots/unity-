import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { adminMarkFailedSchema } from '@/lib/payouts/validation'
import { mapPayoutRpcError } from '@/lib/payouts/rpc-errors'
import { computeMarkFailedHash, checkIdempotentReplay } from '@/lib/payouts/idempotency'
import { notifyMerchantPayoutEvent } from '@/lib/payouts/notify'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/admin/payouts/[id]/mark-failed -- processing -> failed only.
 * Deliberately does NOT re-validate positive eligibility (unlike
 * mark-processing/retry) -- this action must remain usable precisely
 * because eligibility has broken down (a refund appeared, a dispute
 * opened, the merchant became restricted, a provider/operational issue
 * occurred). failure_message_safe is derived server-side from the
 * normalized category, never from the admin's own free-text reason.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: payoutId } = await params
  if (!isValidUuid(payoutId)) {
    return NextResponse.json({ error: 'Invalid payout id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:payouts:mark-failed')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Payout storage is not configured' }, { status: 503 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  const parsed = adminMarkFailedSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const adminId = gate.requester.userId

  if (parsed.data.idempotency_key) {
    const hash = computeMarkFailedHash(payoutId, parsed.data.failureCategory, parsed.data.reason)
    const replay = await checkIdempotentReplay(admin, adminId, 'mark_payout_failed', parsed.data.idempotency_key, hash)
    if (replay.status === 'replay') return NextResponse.json(replay.result)
    if (replay.status === 'conflict') {
      const mapped = mapPayoutRpcError('idempotency key already used with a different request')
      return NextResponse.json({ error: mapped.error }, { status: mapped.status })
    }
  }

  const { data, error } = await admin.rpc('mark_payout_failed', {
    p_admin_id: adminId,
    p_payout_id: payoutId,
    p_failure_category: parsed.data.failureCategory,
    p_reason: parsed.data.reason,
    p_idempotency_key: parsed.data.idempotency_key ?? null,
  })

  if (error) {
    console.error('[admin.payouts.mark-failed] RPC error', { adminId, payoutId, error })
    const mapped = mapPayoutRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }

  try {
    await notifyMerchantPayoutEvent(admin, payoutId, 'merchant_payout.failed', parsed.data.idempotency_key)
  } catch (emailErr) {
    console.error('[admin.payouts.mark-failed] email dispatch failed', { payoutId, emailErr })
  }

  return NextResponse.json(data)
}
