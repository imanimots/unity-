import { NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { getAdminServiceClient } from '@/lib/admin/route-helpers'
import { getMerchantEntitlements } from '@/lib/subscriptions/entitlements'
import { buildListingsCsv, LISTING_CSV_COLUMNS } from '@/lib/subscriptions/csv'

/**
 * GET /api/listings/export -- Pro/Elite only (Section 7). Exports only
 * the caller's OWN listing-management fields (LISTING_CSV_COLUMNS) --
 * no buyer identity, messages, KYC, bank data, or dispute content ever
 * enters the selected column set. Every cell is formula-injection-safe
 * (csvSafeCell).
 */
export async function GET() {
  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
  }

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Listing storage is not configured' }, { status: 503 })
  }

  const entitlements = await getMerchantEntitlements(admin, requester.userId)
  if (!entitlements.csvExportEnabled) {
    return NextResponse.json({ error: 'CSV export requires an active Pro or Elite subscription' }, { status: 403 })
  }

  const { data, error } = await admin.from('listings').select(LISTING_CSV_COLUMNS.join(',')).eq('merchant_id', requester.userId).eq('is_test', false)
  if (error) {
    console.error('[listings.export] error', { userId: requester.userId, error })
    return NextResponse.json({ error: 'Could not export your listings — please try again' }, { status: 500 })
  }

  const csv = buildListingsCsv((data ?? []) as unknown as Record<string, unknown>[])
  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="unity-listings-export.csv"',
    },
  })
}
