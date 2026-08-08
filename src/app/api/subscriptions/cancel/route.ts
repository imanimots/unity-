import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { getAdminServiceClient } from '@/lib/admin/route-helpers'
import { cancelPendingPlanChangeSchema } from '@/lib/subscriptions/validation'
import { mapSubscriptionRpcError } from '@/lib/subscriptions/rpc-errors'
import { notifyMerchantSubscriptionEvent } from '@/lib/subscriptions/notify'

/**
 * POST /api/subscriptions/cancel -- schedules a reversion to Starter one
 * month out (never immediate). Always targets 'starter' -- the request
 * body carries no target, unlike downgrade, since there is only one
 * possible outcome for "cancel."
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

  const { data, error } = await admin.rpc('request_merchant_plan_change', {
    p_merchant_id: requester.userId,
    p_target_plan_id: 'starter',
    p_billing_reference: null,
    p_idempotency_key: parsed.data.idempotency_key ?? null,
  })

  if (error) {
    console.error('[subscriptions.cancel] RPC error', { userId: requester.userId, error })
    const mapped = mapSubscriptionRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }

  try {
    const effectiveAt = (data as { pending_plan_effective_at?: string } | null)?.pending_plan_effective_at ?? ''
    await notifyMerchantSubscriptionEvent(
      admin,
      requester.userId,
      'merchant_subscription.cancellation',
      'merchant-subscription-cancellation-scheduled',
      `subscription-cancellation-${requester.userId}-${effectiveAt}`
    )
  } catch (emailErr) {
    console.error('[subscriptions.cancel] email dispatch failed', { userId: requester.userId, emailErr })
  }

  return NextResponse.json(data)
}
