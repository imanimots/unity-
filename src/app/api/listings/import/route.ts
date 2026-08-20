import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { getAdminServiceClient } from '@/lib/admin/route-helpers'
import { getMerchantEntitlements } from '@/lib/subscriptions/entitlements'
import { parseCsv, LISTING_CSV_COLUMNS } from '@/lib/subscriptions/csv'
import { resolveEffectiveCountry } from '@/lib/resolve-effective-country'

const bodySchema = z.object({ csv: z.string().min(1).max(500_000) })

/**
 * POST /api/listings/import -- Pro/Elite only (Section 5-6). Every row
 * lands as a DRAFT (merchant_import_listing_drafts never sets any other
 * status) -- publishing later goes through the canonical, cap/KYC/
 * moderation-checked publish RPCs, so import cannot bypass any of that.
 * Returns a per-row validation report, never an all-or-nothing failure.
 */
export async function POST(request: NextRequest) {
  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
  }

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Listing storage is not configured' }, { status: 503 })
  }

  const entitlements = await getMerchantEntitlements(admin, requester.userId)
  if (!entitlements.csvImportEnabled) {
    return NextResponse.json({ error: 'CSV import requires an active Pro or Elite subscription' }, { status: 403 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  const parsedRows = parseCsv(parsed.data.csv)
  if (parsedRows.length < 2) {
    return NextResponse.json({ error: 'CSV must have a header row and at least one data row' }, { status: 400 })
  }

  const header = parsedRows[0].map((h) => h.trim())
  const dataRows = parsedRows.slice(1)
  if (dataRows.length > 200) {
    return NextResponse.json({ error: 'Import is limited to 200 rows at a time' }, { status: 400 })
  }

  const rows = dataRows.map((cells) => {
    const row: Record<string, string> = {}
    for (const col of LISTING_CSV_COLUMNS) {
      const idx = header.indexOf(col)
      if (idx >= 0 && cells[idx] !== undefined) row[col] = cells[idx]
    }
    return row
  })

  const { countryId } = await resolveEffectiveCountry()

  const { data, error } = await admin.rpc('merchant_import_listing_drafts', {
    p_merchant_id: requester.userId,
    p_country_id: countryId,
    p_rows: rows,
  })

  if (error) {
    console.error('[listings.import] RPC error', { userId: requester.userId, error })
    return NextResponse.json({ error: 'Could not import listings — please try again' }, { status: 500 })
  }

  return NextResponse.json(data)
}
