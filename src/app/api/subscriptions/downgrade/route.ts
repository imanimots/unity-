import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { getAdminServiceClient } from '@/lib/admin/route-helpers'
import { requestDowngradeSchema } from '@/lib/subscriptions/validation'
import { mapSubscriptionRpcError } from '@/lib/subscriptions/rpc-errors'
import { getMerchantSubscriptionPlan } from '@/lib/subscriptions/plans'
import { notifyMerchantSubscriptionEvent } from '@/lib/subscriptions/notify'

/**
 * POST /api/subscriptions/downgrade -- schedules a downgrade to a
 * lower-ranked PAID plan, always one month out, never immediate (the
 * merchant already paid for the current period). To cancel down to
 * Starter, use POST /api/subscriptions/cancel instead (same underlying
 * RPC, different intent-signaling endpoint). No billing reference is
 * ever needed here -- request_merchant_plan_change() only requires one
 * on the upgrade branch.
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

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  const parsed = requestDowngradeSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  if (parsed.data.targetPlanId === 'starter') {
    return NextResponse.json({ error: 'Use /api/subscriptions/cancel to move to Starter.' }, { status: 400 })
  }

  const plan = await getMerchantSubscriptionPlan(admin, parsed.data.targetPlanId)
  if (!plan || !plan.is_active) {
    return NextResponse.json({ error: 'That plan is not currently available.' }, { status: 400 })
  }

  const { data, error } = await admin.rpc('request_merchant_plan_change', {
    p_merchant_id: requester.userId,
    p_target_plan_id: parsed.data.targetPlanId,
    p_billing_reference: null,
    p_idempotency_key: parsed.data.idempotency_key ?? null,
  })

  if (error) {
    console.error('[subscriptions.downgrade] RPC error', { userId: requester.userId, error })
    const mapped = mapSubscriptionRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }

  try {
    const effectiveAt = (data as { pending_plan_effective_at?: string } | null)?.pending_plan_effective_at ?? ''
    await notifyMerchantSubscriptionEvent(
      admin,
      requester.userId,
      'merchant_subscription.downgrade',
      'merchant-subscription-downgrade-scheduled',
      `subscription-downgrade-${requester.userId}-${parsed.data.targetPlanId}-${effectiveAt}`,
      { planName: plan.display_name }
    )
  } catch (emailErr) {
    console.error('[subscriptions.downgrade] email dispatch failed', { userId: requester.userId, emailErr })
  }

  return NextResponse.json(data)
}
