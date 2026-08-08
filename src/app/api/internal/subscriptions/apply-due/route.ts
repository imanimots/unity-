import { NextRequest, NextResponse } from 'next/server'
import { notifyMerchantSubscriptionEvent } from '@/lib/subscriptions/notify'

/**
 * POST /api/internal/subscriptions/apply-due -- secret-authenticated
 * explicit trigger for the same sweep that runs opportunistically from
 * GET /api/subscriptions/me and the admin list/detail routes
 * (apply_due_merchant_subscription_changes(), naturally idempotent).
 * This route exists so a real scheduler can guarantee the sweep runs
 * even for merchants who never happen to hit a read path around their
 * due date -- documented for manual curl invocation in
 * docs/PUBLIC_TEST_RUNBOOK.md pending real Vercel cron wiring, matching
 * every other internal route in this codebase.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.INTERNAL_CRON_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'Internal subscription sweep endpoint is not configured' }, { status: 503 })
  }
  const provided = request.headers.get('authorization')
  if (provided !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Subscription storage is not configured' }, { status: 503 })
  }

  try {
    const { createClient } = await import('@supabase/supabase-js')
    const admin = createClient(url, serviceKey)

    const { data, error } = await admin.rpc('apply_due_merchant_subscription_changes')
    if (error) {
      console.error('[internal.subscriptions.apply-due] RPC error', error)
      return NextResponse.json({ error: 'Sweep failed' }, { status: 500 })
    }

    const applied = (data?.applied ?? []) as Array<{ merchantId: string; previousPlanId: string; newPlanId: string; changeCategory: string }>

    for (const change of applied) {
      try {
        await notifyMerchantSubscriptionEvent(
          admin,
          change.merchantId,
          `merchant_subscription.${change.changeCategory}`,
          change.changeCategory === 'reversion' ? 'merchant-subscription-reverted' : 'merchant-subscription-downgrade-applied',
          `subscription-sweep-${change.merchantId}-${change.newPlanId}-${change.changeCategory}`
        )
      } catch (emailErr) {
        console.error('[internal.subscriptions.apply-due] email dispatch failed', { merchantId: change.merchantId, emailErr })
      }
    }

    return NextResponse.json({ applied: applied.length, count: data?.count ?? applied.length })
  } catch (err) {
    console.error('[internal.subscriptions.apply-due] unexpected error', err)
    return NextResponse.json({ error: 'Sweep failed' }, { status: 500 })
  }
}
