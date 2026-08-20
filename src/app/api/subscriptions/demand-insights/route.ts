import { NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { getAdminServiceClient } from '@/lib/admin/route-helpers'
import { getMerchantEntitlements } from '@/lib/subscriptions/entitlements'
import { getDemandInsights } from '@/lib/subscriptions/demand'

/**
 * GET /api/subscriptions/demand-insights -- Pro/Elite only (Section
 * 73). Starter gets a safe entitlement error, never a hidden-UI-only
 * gate. Response carries only aggregate trend rows -- see
 * src/lib/subscriptions/demand.ts for the privacy-threshold/test-
 * exclusion guarantees.
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

  const entitlements = await getMerchantEntitlements(admin, requester.userId)
  if (!entitlements.demandInsightsEnabled) {
    return NextResponse.json({ error: 'Demand insights require an active Pro or Elite subscription' }, { status: 403 })
  }

  const insights = await getDemandInsights(admin)
  return NextResponse.json(insights)
}
