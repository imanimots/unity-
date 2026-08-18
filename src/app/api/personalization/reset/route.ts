import { NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { getAdminServiceClient } from '@/lib/admin/route-helpers'
import { isPersonalizationEnabled } from '@/lib/personalization/config'
import { resetPersonalizationHistory } from '@/lib/personalization/preferences'

/**
 * POST /api/personalization/reset -- "Clear personalization history"
 * (Section 38). Wipes behavioral view history and bumps the reset
 * cutoff. Never deletes orders/bookings/barter agreements/RTB
 * agreements/reviews -- those remain authoritative product records;
 * only their FUTURE influence on personalization stops until new
 * activity accrues.
 */
export async function POST() {
  if (!isPersonalizationEnabled()) {
    return NextResponse.json({ error: 'Personalization is not enabled' }, { status: 404 })
  }
  const requester = await getRequestProfile()
  if (!requester) return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })

  const admin = await getAdminServiceClient()
  if (!admin) return NextResponse.json({ error: 'Personalization storage is not configured' }, { status: 503 })

  const result = await resetPersonalizationHistory(admin, requester.userId)
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 503 })
  }
  return NextResponse.json({ ok: true })
}
