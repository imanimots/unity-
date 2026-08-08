import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { getAdminServiceClient } from '@/lib/admin/route-helpers'
import { requestUpgradeSchema } from '@/lib/subscriptions/validation'
import { mapSubscriptionRpcError } from '@/lib/subscriptions/rpc-errors'
import { getMerchantSubscriptionPlan } from '@/lib/subscriptions/plans'
import { attemptSubscriptionBilling } from '@/lib/subscriptions/billing/service'
import { isSubscriptionMockScenarioSelectionAllowed, isSubscriptionMockScenario } from '@/lib/subscriptions/billing/test-scenario'
import { notifyMerchantSubscriptionEvent } from '@/lib/subscriptions/notify'

/**
 * POST /api/subscriptions/upgrade -- immediate upgrade to a
 * higher-ranked plan. The billing charge always happens here,
 * server-side, before the RPC is ever called -- request_merchant_plan_change()
 * requires a billing_reference for an upgrade and has no way to verify
 * one itself (it trusts the reference was already produced by a real
 * charge attempt, matching how every other orchestrator-then-RPC call
 * site in this codebase works: the RPC records outcomes, JS drives the
 * actual provider call). mockScenario is only honoured when
 * isSubscriptionMockScenarioSelectionAllowed() is true.
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
  const parsed = requestUpgradeSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const plan = await getMerchantSubscriptionPlan(admin, parsed.data.targetPlanId)
  if (!plan || !plan.is_active) {
    return NextResponse.json({ error: 'That plan is not currently available.' }, { status: 400 })
  }

  const mockScenario = isSubscriptionMockScenarioSelectionAllowed() && isSubscriptionMockScenario(parsed.data.mockScenario) ? parsed.data.mockScenario : undefined

  let billing
  try {
    billing = await attemptSubscriptionBilling(admin, {
      merchantId: requester.userId,
      planId: plan.id,
      amountCents: plan.monthly_fee_cents,
      currency: plan.currency,
      idempotencyKey: parsed.data.idempotency_key,
      mockScenario,
    })
  } catch (err) {
    console.error('[subscriptions.upgrade] billing attempt failed', { userId: requester.userId, err })
    return NextResponse.json({ error: 'Could not process your payment — please try again' }, { status: 502 })
  }

  if (!billing.success) {
    return NextResponse.json({ error: 'Your payment was declined. Please try again.', billingAttemptId: billing.billingAttemptId }, { status: 402 })
  }

  const { data, error } = await admin.rpc('request_merchant_plan_change', {
    p_merchant_id: requester.userId,
    p_target_plan_id: parsed.data.targetPlanId,
    p_billing_reference: billing.providerReference,
    p_idempotency_key: parsed.data.idempotency_key ?? null,
  })

  if (error) {
    console.error('[subscriptions.upgrade] RPC error', { userId: requester.userId, error })
    const mapped = mapSubscriptionRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }

  try {
    // occurrenceKey is derived from the RPC's own returned effective
    // timestamp, never self-generated -- deterministic per real
    // transition, so an exact route retry can never double-send while a
    // genuinely later upgrade to the same plan still gets its own email.
    const effectiveAt = (data as { current_plan_effective_at?: string } | null)?.current_plan_effective_at ?? ''
    await notifyMerchantSubscriptionEvent(
      admin,
      requester.userId,
      'merchant_subscription.upgrade',
      'merchant-subscription-upgraded',
      `subscription-upgrade-${requester.userId}-${parsed.data.targetPlanId}-${effectiveAt}`,
      { planName: plan.display_name }
    )
  } catch (emailErr) {
    console.error('[subscriptions.upgrade] email dispatch failed', { userId: requester.userId, emailErr })
  }

  return NextResponse.json(data)
}
