import { NextRequest, NextResponse } from 'next/server'
import { notifyMerchantSubscriptionEvent } from '@/lib/subscriptions/notify'
import { hasCronAuthConfigured, isAuthorizedCronRequest } from '@/lib/internal-cron/auth'

/**
 * GET|POST /api/internal/subscriptions/apply-due -- explicit trigger
 * for the same sweep that runs opportunistically from GET
 * /api/subscriptions/me and the admin list/detail routes
 * (apply_due_merchant_subscription_changes(), naturally idempotent).
 * Scheduled via vercel.json (P4) so it now guarantees the sweep runs
 * even for merchants who never happen to hit a read path around their
 * due date. GET (Vercel Cron) and POST (manual/curl) share one handler
 * and the shared isAuthorizedCronRequest() authority
 * (src/lib/internal-cron/auth.ts).
 */
async function handleCronRequest(request: NextRequest) {
  if (!hasCronAuthConfigured()) {
    return NextResponse.json({ error: 'Internal subscription sweep endpoint is not configured' }, { status: 503 })
  }
  if (!isAuthorizedCronRequest(request)) {
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

export async function GET(request: NextRequest) {
  return handleCronRequest(request)
}

export async function POST(request: NextRequest) {
  return handleCronRequest(request)
}
