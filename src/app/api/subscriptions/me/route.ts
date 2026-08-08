import { NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { getAdminServiceClient } from '@/lib/admin/route-helpers'
import { getEffectiveMerchantPlan } from '@/lib/subscriptions/effective-plan'
import { getMerchantSubscriptionPlans } from '@/lib/subscriptions/plans'
import { getListingEntitlementUsage } from '@/lib/subscriptions/entitlements'
import { getCurrentMonthMerchantVolume } from '@/lib/subscriptions/monthly-volume'
import { computeMonthlyPlanCost, findCheapestPlans, computeSavingsCents } from '@/lib/subscriptions/economics'
import { triggerMerchantSubscriptionLazySweep } from '@/lib/subscriptions/lazy-expiry'
import { notifyMerchantSubscriptionEvent } from '@/lib/subscriptions/notify'

/**
 * GET /api/subscriptions/me -- the caller's own plan, subscription
 * state, listing entitlement usage, and an economics summary (current
 * plan cost, cheapest plan(s) given this month's real volume, and
 * potential savings). Opportunistically runs the due-change lazy sweep
 * first (mirrors triggerBarterLazyExpirySweep's call-before-read
 * pattern) so a merchant whose scheduled downgrade/cancellation just
 * became due sees the applied result immediately rather than stale
 * "pending" state.
 */
export async function GET() {
  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
  }

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Subscription storage is not configured' }, { status: 503 })
  }

  try {
    const applied = await triggerMerchantSubscriptionLazySweep(admin)
    if (applied) {
      for (const change of applied) {
        if (change.merchantId !== requester.userId) continue
        try {
          await notifyMerchantSubscriptionEvent(
            admin,
            change.merchantId,
            `merchant_subscription.${change.changeCategory}`,
            change.changeCategory === 'reversion' ? 'merchant-subscription-reverted' : 'merchant-subscription-downgrade-applied',
            `subscription-sweep-${change.merchantId}-${change.newPlanId}-${change.changeCategory}`
          )
        } catch (emailErr) {
          console.error('[subscriptions.me] sweep email dispatch failed', { merchantId: change.merchantId, emailErr })
        }
      }
    }

    const [{ planId, plan, subscription }, allPlans, listingUsage, volume] = await Promise.all([
      getEffectiveMerchantPlan(admin, requester.userId),
      getMerchantSubscriptionPlans(admin),
      getListingEntitlementUsage(admin, requester.userId),
      getCurrentMonthMerchantVolume(admin, requester.userId),
    ])

    const currentCost = computeMonthlyPlanCost(plan, volume)
    const cheapest = findCheapestPlans(allPlans, volume)
    const recommendations = cheapest.breakdowns
      .filter((b) => b.planId !== planId)
      .map((b) => ({ ...b, savingsCents: computeSavingsCents(currentCost.totalCostCents, b.totalCostCents) }))
      .filter((b) => b.savingsCents > 0)

    return NextResponse.json({
      planId,
      plan,
      subscription: subscription
        ? {
            status: subscription.status,
            currentPlanId: subscription.current_plan_id,
            currentPlanEffectiveAt: subscription.current_plan_effective_at,
            pendingPlanId: subscription.pending_plan_id,
            pendingPlanEffectiveAt: subscription.pending_plan_effective_at,
            lastTransitionCategory: subscription.last_transition_category,
          }
        : null,
      listingUsage,
      economics: {
        currentMonthVolume: volume,
        currentPlanCost: currentCost,
        cheapestPlanIds: cheapest.cheapestPlanIds,
        isTieAtCheapest: cheapest.isTie,
        allPlanCosts: cheapest.breakdowns,
        recommendations,
      },
    })
  } catch (err) {
    console.error('[subscriptions.me] error', { userId: requester.userId, err })
    return NextResponse.json({ error: 'Could not load your subscription' }, { status: 500 })
  }
}
