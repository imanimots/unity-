import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { adminCorrectSubscriptionSchema } from '@/lib/subscriptions/validation'
import { mapSubscriptionRpcError } from '@/lib/subscriptions/rpc-errors'
import { notifyMerchantSubscriptionEvent } from '@/lib/subscriptions/notify'
import { getMerchantSubscriptionPlan } from '@/lib/subscriptions/plans'

interface RouteParams {
  params: Promise<{ merchantId: string }>
}

/**
 * POST /api/admin/subscriptions/[merchantId]/correct -- a narrow,
 * reason-required admin override. Never charges the merchant, never
 * rewrites history -- admin_correct_merchant_subscription() appends a
 * new history row with actor_type='admin' and change_category
 * 'admin_correction'.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { merchantId } = await params
  if (!isValidUuid(merchantId)) {
    return NextResponse.json({ error: 'Invalid merchant id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:subscriptions:correct')
  if (!gate.ok) return gate.response

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
  const parsed = adminCorrectSubscriptionSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const adminId = gate.requester.userId

  const { data, error } = await admin.rpc('admin_correct_merchant_subscription', {
    p_admin_id: adminId,
    p_merchant_id: merchantId,
    p_new_plan_id: parsed.data.newPlanId,
    p_immediate: parsed.data.immediate,
    p_reason: parsed.data.reason,
    p_idempotency_key: parsed.data.idempotency_key ?? null,
  })

  if (error) {
    console.error('[admin.subscriptions.correct] RPC error', { adminId, merchantId, error })
    const mapped = mapSubscriptionRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }

  try {
    const plan = await getMerchantSubscriptionPlan(admin, parsed.data.newPlanId)
    const effectiveAt = (data as { current_plan_effective_at?: string; pending_plan_effective_at?: string } | null) ?? {}
    const occurrenceStamp = parsed.data.immediate ? effectiveAt.current_plan_effective_at : effectiveAt.pending_plan_effective_at
    await notifyMerchantSubscriptionEvent(
      admin,
      merchantId,
      'merchant_subscription.admin_correction',
      'merchant-subscription-admin-corrected',
      `subscription-admin-correction-${merchantId}-${parsed.data.newPlanId}-${occurrenceStamp ?? ''}`,
      { planName: plan?.display_name ?? parsed.data.newPlanId }
    )
  } catch (emailErr) {
    console.error('[admin.subscriptions.correct] email dispatch failed', { merchantId, emailErr })
  }

  return NextResponse.json(data)
}
