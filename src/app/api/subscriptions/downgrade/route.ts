import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { getAdminServiceClient } from '@/lib/admin/route-helpers'
import { requestDowngradeSchema } from '@/lib/subscriptions/validation'
import { mapSubscriptionRpcError } from '@/lib/subscriptions/rpc-errors'
import { getMerchantSubscriptionPlan } from '@/lib/subscriptions/plans'
import { getEffectiveMerchantPlan } from '@/lib/subscriptions/effective-plan'
import { getPublicationUsage } from '@/lib/subscriptions/entitlements'
import { computeDowngradeChangeKeys, encodeDowngradeReason } from '@/lib/subscriptions/downgrade-diff'
import { notifyMerchantSubscriptionEvent } from '@/lib/subscriptions/notify'

/**
 * POST /api/subscriptions/downgrade -- schedules a downgrade to a
 * lower-ranked PAID plan, always one month out, never immediate (the
 * merchant already paid for the current period). Section 52's
 * deliberate consequence flow is enforced HERE, server-side, not just
 * in the UI: a reason is required, every entitlement the merchant
 * actually loses must be individually acknowledged, and -- only when
 * their current usage exceeds the target plan's cap -- a valid keep-set
 * of entities to remain active must be supplied. To cancel down to
 * Starter, use POST /api/subscriptions/cancel instead (same underlying
 * RPC, same requirements, different intent-signaling endpoint).
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

  const targetPlan = await getMerchantSubscriptionPlan(admin, parsed.data.targetPlanId)
  if (!targetPlan || !targetPlan.is_active) {
    return NextResponse.json({ error: 'That plan is not currently available.' }, { status: 400 })
  }

  const { plan: currentPlan } = await getEffectiveMerchantPlan(admin, requester.userId)

  const requiredKeys = computeDowngradeChangeKeys(currentPlan, targetPlan)
  const acknowledged = new Set(parsed.data.acknowledgedChangeKeys)
  const missing = requiredKeys.filter((k) => !acknowledged.has(k))
  if (missing.length > 0) {
    return NextResponse.json({ error: 'You must acknowledge every change before downgrading.', missingAcknowledgements: missing }, { status: 400 })
  }

  const usage = await getPublicationUsage(admin, requester.userId)
  const needsKeepSet = targetPlan.active_publication_limit !== null && usage.activeCount > targetPlan.active_publication_limit
  if (needsKeepSet && (!parsed.data.keepSetEntities || parsed.data.keepSetEntities.length === 0)) {
    return NextResponse.json(
      { error: 'You must choose which published items stay active on your target plan.', needsKeepSet: true, publicationLimit: targetPlan.active_publication_limit, activeCount: usage.activeCount },
      { status: 400 }
    )
  }

  const reason = encodeDowngradeReason(parsed.data.reasonCategory, parsed.data.reasonText)

  const { data, error } = await admin.rpc('request_merchant_plan_change', {
    p_merchant_id: requester.userId,
    p_target_plan_id: parsed.data.targetPlanId,
    p_billing_reference: null,
    p_reason: reason,
    p_idempotency_key: parsed.data.idempotency_key ?? null,
  })

  if (error) {
    console.error('[subscriptions.downgrade] RPC error', { userId: requester.userId, error })
    const mapped = mapSubscriptionRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }

  if (needsKeepSet && parsed.data.keepSetEntities) {
    const { error: keepSetError } = await admin.rpc('set_merchant_downgrade_keep_set', {
      p_merchant_id: requester.userId,
      p_entities: parsed.data.keepSetEntities.map((e) => ({ entityType: e.entityType, entityId: e.entityId })),
      p_idempotency_key: parsed.data.idempotency_key ? `${parsed.data.idempotency_key}-keepset` : null,
    })
    if (keepSetError) {
      console.error('[subscriptions.downgrade] keep-set RPC error', { userId: requester.userId, keepSetError })
      const mapped = mapSubscriptionRpcError(keepSetError.message)
      return NextResponse.json({ error: mapped.error }, { status: mapped.status })
    }
  }

  try {
    const effectiveAt = (data as { pending_plan_effective_at?: string } | null)?.pending_plan_effective_at ?? ''
    await notifyMerchantSubscriptionEvent(
      admin,
      requester.userId,
      'merchant_subscription.downgrade',
      'merchant-subscription-downgrade-scheduled',
      `subscription-downgrade-${requester.userId}-${parsed.data.targetPlanId}-${effectiveAt}`,
      { planName: targetPlan.display_name }
    )
  } catch (emailErr) {
    console.error('[subscriptions.downgrade] email dispatch failed', { userId: requester.userId, emailErr })
  }

  return NextResponse.json(data)
}
