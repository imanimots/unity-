import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { getAdminServiceClient } from '@/lib/admin/route-helpers'
import { getMerchantEntitlements } from '@/lib/subscriptions/entitlements'

const bodySchema = z.object({ idempotency_key: z.string().trim().min(1).max(200).optional() })

interface RouteParams {
  params: Promise<{ id: string }>
}

/** POST /api/listings/[id]/duplicate -- Pro/Elite only (Section 41-43). Clones authoring fields into a new DRAFT; publishing it later consumes one global slot like any other publish. */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: listingId } = await params
  if (!/^[0-9a-f-]{36}$/i.test(listingId)) {
    return NextResponse.json({ error: 'Invalid listing id' }, { status: 400 })
  }

  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
  }

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Listing storage is not configured' }, { status: 503 })
  }

  const entitlements = await getMerchantEntitlements(admin, requester.userId)
  if (!entitlements.duplicateListingEnabled) {
    return NextResponse.json({ error: 'Duplicating listings requires an active Pro or Elite subscription' }, { status: 403 })
  }

  let body: unknown = {}
  try {
    body = await request.json()
  } catch {
    body = {}
  }
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  const { data, error } = await admin.rpc('duplicate_listing', {
    p_merchant_id: requester.userId,
    p_listing_id: listingId,
    p_idempotency_key: parsed.data.idempotency_key ?? null,
  })

  if (error) {
    console.error('[listings.duplicate] RPC error', { userId: requester.userId, listingId, error })
    const message = error.message ?? ''
    if (message.includes('you do not own this listing')) return NextResponse.json({ error: 'You do not own this listing.' }, { status: 403 })
    if (message.includes('listing not found')) return NextResponse.json({ error: 'Listing not found.' }, { status: 404 })
    return NextResponse.json({ error: 'Could not duplicate this listing — please try again' }, { status: 500 })
  }

  return NextResponse.json(data)
}
