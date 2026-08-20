import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { getAdminServiceClient } from '@/lib/admin/route-helpers'
import { getMerchantEntitlements } from '@/lib/subscriptions/entitlements'

const bodySchema = z.object({
  action: z.enum(['pause', 'resume']),
  listingIds: z.array(z.string().uuid()).min(1).max(50),
})

/**
 * POST /api/listings/bulk -- Pro/Elite only (Section 41-42). Loops the
 * EXISTING single-listing merchant_pause_listing/merchant_resume_listing
 * RPCs -- each call is independently ownership-checked and, for resume,
 * cap-checked -- so a bulk action can never bypass the global
 * publication cap or touch another merchant's listing. Partial success
 * is reported per-id rather than an all-or-nothing transaction, since
 * one listing being in the wrong state should not block the rest.
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
  if (!entitlements.bulkListingEnabled) {
    return NextResponse.json({ error: 'Bulk listing management requires an active Pro or Elite subscription' }, { status: 403 })
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

  const rpcName = parsed.data.action === 'pause' ? 'merchant_pause_listing' : 'merchant_resume_listing'
  const results: { listingId: string; ok: boolean; error?: string }[] = []

  for (const listingId of parsed.data.listingIds) {
    const { error } = await admin.rpc(rpcName, { p_merchant_id: requester.userId, p_listing_id: listingId })
    results.push({ listingId, ok: !error, error: error?.message })
  }

  return NextResponse.json({ results, succeeded: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length })
}
