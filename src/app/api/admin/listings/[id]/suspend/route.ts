import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { suspendSchema } from '@/lib/listings/admin-validation'
import { suspendListing } from '@/lib/listings/moderation-service'
import { mapAdminRpcError } from '@/lib/listings/admin-rpc-errors'
import { sendTemplate, loadListingEmailContext } from '@/lib/email'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/admin/listings/[id]/suspend -- pulls an active listing out of
 * circulation administratively. Recovery is the activate route above,
 * which re-runs the full eligibility check (suspend_listing() itself
 * never touches moderation_status -- see its comment in
 * 20260803000003_admin_moderation_rpcs.sql).
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: listingId } = await params
  if (!isValidUuid(listingId)) {
    return NextResponse.json({ error: 'Invalid listing id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:listings:suspend')
  if (!gate.ok) return gate.response

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  const parsed = suspendSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Listing storage is not configured' }, { status: 503 })
  }

  const { data, error } = await suspendListing(
    admin,
    listingId,
    gate.requester.userId,
    parsed.data.reason_code ?? null,
    parsed.data.internal_note ?? null,
    parsed.data.merchant_feedback ?? null,
    parsed.data.idempotency_key
  )

  if (error) {
    console.error('[admin.listings.suspend] RPC error', { listingId, error })
    const mapped = mapAdminRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }

  try {
    const ctx = await loadListingEmailContext(admin, listingId)
    if (ctx) {
      await sendTemplate(admin, {
        eventType: 'listing.suspended',
        templateId: 'listing-suspended-merchant',
        recipientUserId: ctx.merchantId,
        relatedEntityType: 'listing',
        relatedEntityId: listingId,
        vars: { merchantName: ctx.merchantName, listingTitle: ctx.listingTitle, feedback: parsed.data.merchant_feedback ?? 'No specific reason was provided.' },
      })
    }
  } catch (emailErr) {
    console.error('[admin.listings.suspend] email dispatch failed', { listingId, emailErr })
  }

  return NextResponse.json(data)
}
