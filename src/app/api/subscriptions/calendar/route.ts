import { NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { getAdminServiceClient } from '@/lib/admin/route-helpers'
import { getMerchantEntitlements } from '@/lib/subscriptions/entitlements'
import { getMerchantCalendarView } from '@/lib/subscriptions/calendar'

/** GET /api/subscriptions/calendar -- Pro/Elite only (Section 9-10). Own data only. */
export async function GET() {
  const requester = await getRequestProfile()
  if (!requester) return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })

  const admin = await getAdminServiceClient()
  if (!admin) return NextResponse.json({ error: 'Subscription storage is not configured' }, { status: 503 })

  const entitlements = await getMerchantEntitlements(admin, requester.userId)
  if (!entitlements.inventoryCalendarEnabled) {
    return NextResponse.json({ error: 'The inventory/calendar view requires an active Pro or Elite subscription' }, { status: 403 })
  }

  const view = await getMerchantCalendarView(admin, requester.userId)
  return NextResponse.json(view)
}
