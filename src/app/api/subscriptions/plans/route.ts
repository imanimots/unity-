import { NextResponse } from 'next/server'
import { getAdminServiceClient } from '@/lib/admin/route-helpers'
import { getMerchantSubscriptionPlans } from '@/lib/subscriptions/plans'

/**
 * GET /api/subscriptions/plans -- the public plan catalog (Starter, Pro,
 * Elite), used by both the /pricing page and the merchant dashboard's
 * upgrade/downgrade picker. No auth required -- pricing is public.
 */
export async function GET() {
  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Subscription storage is not configured' }, { status: 503 })
  }

  try {
    const plans = await getMerchantSubscriptionPlans(admin)
    return NextResponse.json({ plans })
  } catch (err) {
    console.error('[subscriptions.plans] error', err)
    return NextResponse.json({ error: 'Could not load plans' }, { status: 500 })
  }
}
