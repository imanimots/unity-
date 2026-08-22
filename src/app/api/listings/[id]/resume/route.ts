import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { mapListingRpcError } from '@/lib/listings/rpc-errors'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/listings/[id]/resume -- individual listing resume, available
 * to EVERY merchant subscription tier. Same reasoning as .../pause: no
 * entitlements.bulkListingEnabled gate here (that stays exclusive to
 * POST /api/listings/bulk's *bulk* capability). merchant_resume_listing
 * is a genuine new publication/reactivation event -- it already
 * revalidates the current publication-freeze state and the caller's
 * current plan cap (Starter 5 / Pro 20 / Elite unlimited) inside the RPC
 * itself, so a Starter merchant resuming into a full cap is correctly
 * denied with the same active_publication_limit_reached error every
 * other activation path already produces -- resume never bypasses the
 * cap just because the request came from the single-listing route.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: listingId } = await params
  if (!isValidUuid(listingId)) {
    return NextResponse.json({ error: 'Invalid listing id' }, { status: 400 })
  }

  const rate = checkRateLimit(`listings:resume:${getClientKey(request)}`, 20, 60_000)
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

  const { data, error } = await admin.rpc('merchant_resume_listing', {
    p_merchant_id: requester.userId,
    p_listing_id: listingId,
  })

  if (error) {
    console.error('[listings.resume] RPC error', { userId: requester.userId, listingId, error })
    const mapped = mapListingRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }

  return NextResponse.json(data)
}
