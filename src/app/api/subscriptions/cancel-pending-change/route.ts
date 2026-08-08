import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { getAdminServiceClient } from '@/lib/admin/route-helpers'
import { cancelPendingPlanChangeSchema } from '@/lib/subscriptions/validation'
import { mapSubscriptionRpcError } from '@/lib/subscriptions/rpc-errors'
import { notifyMerchantSubscriptionEvent } from '@/lib/subscriptions/notify'

/**
 * POST /api/subscriptions/cancel-pending-change -- reverts a scheduled
 * downgrade/cancellation, staying on the current plan. Requires a
 * genuine pending change to exist (enforced inside the RPC).
 */
export async function POST(request: NextRequest) {
  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
  }

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Subscription storage is not configured' }, { status: 503 })
  }

  let body: unknown = {}
  try {
    body = await request.json()
  } catch {
    body = {}
  }
  const parsed = cancelPendingPlanChangeSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const { data, error } = await admin.rpc('cancel_pending_merchant_plan_change', {
    p_merchant_id: requester.userId,
    p_idempotency_key: parsed.data.idempotency_key ?? null,
  })

  if (error) {
    console.error('[subscriptions.cancel-pending-change] RPC error', { userId: requester.userId, error })
    const mapped = mapSubscriptionRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }

  try {
    await notifyMerchantSubscriptionEvent(
      admin,
      requester.userId,
      'merchant_subscription.pending_change_cancelled',
      'merchant-subscription-pending-change-cancelled',
      `subscription-pending-change-cancelled-${requester.userId}-${(data as { updated_at?: string } | null)?.updated_at ?? ''}`
    )
  } catch (emailErr) {
    console.error('[subscriptions.cancel-pending-change] email dispatch failed', { userId: requester.userId, emailErr })
  }

  return NextResponse.json(data)
}
