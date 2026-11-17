import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { isAdvertisingMockScenarioSelectionAllowed } from '@/lib/advertising/test-scenario'

interface RouteParams {
  params: Promise<{ id: string }>
}

/** GET /api/advertising/campaigns/[id]/report -- aggregate-only metrics (never raw impression/click rows, never other users' data). */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  const { id: campaignId } = await params
  if (!isValidUuid(campaignId)) {
    return NextResponse.json({ error: 'Invalid campaign id' }, { status: 400 })
  }
  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
  }

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Advertising storage is not configured' }, { status: 503 })
  }

  const { data, error } = await admin.rpc('get_ad_campaign_report', {
    p_actor_profile_id: requester.userId,
    p_campaign_id: campaignId,
  })

  if (error) {
    return NextResponse.json({ error: error.message ?? 'Could not load report' }, { status: 400 })
  }

  // testModeAvailable tells the client whether it may show an explicit
  // scenario picker for the Fund action -- the fund route independently
  // re-checks the same condition on every request regardless of this
  // flag, so it can only ever widen what the UI offers, never what the
  // server accepts.
  return NextResponse.json({ ...data, testModeAvailable: isAdvertisingMockScenarioSelectionAllowed() })
}
