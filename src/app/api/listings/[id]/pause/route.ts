import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { mapListingRpcError } from '@/lib/listings/rpc-errors'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/listings/[id]/pause -- individual listing pause, available to
 * EVERY merchant subscription tier (Starter/Pro/Elite). This is a basic
 * listing lifecycle control, not a paid entitlement -- deliberately does
 * NOT check entitlements.bulkListingEnabled, unlike POST /api/listings/bulk
 * (which stays Pro/Elite-only for the *bulk* capability). Reuses the
 * existing merchant_pause_listing RPC verbatim -- the same RPC the bulk
 * route already calls per-row -- so ownership/state authority is
 * identical either way; only the entitlement gate differs.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: listingId } = await params
  if (!isValidUuid(listingId)) {
    return NextResponse.json({ error: 'Invalid listing id' }, { status: 400 })
  }

  const rate = checkRateLimit(`listings:pause:${getClientKey(request)}`, 20, 60_000)
  if (!rate.allowed) {
    return NextResponse.json({ error: 'Too many requests — please slow down' }, { status: 429 })
  }

  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
  }

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Listing storage is not configured' }, { status: 503 })
  }

  const { data, error } = await admin.rpc('merchant_pause_listing', {
    p_merchant_id: requester.userId,
    p_listing_id: listingId,
  })

  if (error) {
    console.error('[listings.pause] RPC error', { userId: requester.userId, listingId, error })
    const mapped = mapListingRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }

  return NextResponse.json(data)
}
