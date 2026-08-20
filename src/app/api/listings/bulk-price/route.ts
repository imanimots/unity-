import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { getAdminServiceClient } from '@/lib/admin/route-helpers'
import { getMerchantEntitlements } from '@/lib/subscriptions/entitlements'

const priceUpdateSchema = z.object({
  listingId: z.string().uuid(),
  dailyRate: z.number().min(0).max(1_000_000).optional(),
  weeklyRate: z.number().min(0).max(1_000_000).optional(),
  monthlyRate: z.number().min(0).max(1_000_000).optional(),
  salePrice: z.number().min(0).max(1_000_000).optional(),
})

const bodySchema = z.object({
  updates: z.array(priceUpdateSchema).min(1).max(100),
})

/**
 * POST /api/listings/bulk-price -- Pro/Elite only (Section 8/41).
 * Updates only future listing terms via merchant_bulk_update_listing_prices
 * -- never touches an accepted order/booking/barter/RTB price snapshot
 * or a historical commission record (those live in entirely separate
 * tables the RPC never writes to).
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
  if (!entitlements.bulkPriceUpdateEnabled) {
    return NextResponse.json({ error: 'Bulk price updates require an active Pro or Elite subscription' }, { status: 403 })
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

  const { data, error } = await admin.rpc('merchant_bulk_update_listing_prices', {
    p_merchant_id: requester.userId,
    p_updates: parsed.data.updates,
  })

  if (error) {
    console.error('[listings.bulk-price] RPC error', { userId: requester.userId, error })
    return NextResponse.json({ error: 'Could not update prices — please try again' }, { status: 500 })
  }

  return NextResponse.json(data)
}
