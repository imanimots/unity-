import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { moderationDecisionSchema } from '@/lib/listings/admin-validation'
import { decideModeration } from '@/lib/listings/moderation-service'
import { mapAdminRpcError } from '@/lib/listings/admin-rpc-errors'
import { sendTemplate, loadListingEmailContext } from '@/lib/email'

interface RouteParams {
  params: Promise<{ id: string }>
}

/** POST /api/admin/listings/[id]/moderation/reject -- reject moderation. Reverts listings.status to 'draft' (decide_moderation RPC) so the merchant's existing edit/resubmit flow applies. */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: listingId } = await params
  if (!isValidUuid(listingId)) {
    return NextResponse.json({ error: 'Invalid listing id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:listings:moderation:reject')
  if (!gate.ok) return gate.response

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  const parsed = moderationDecisionSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Listing storage is not configured' }, { status: 503 })
  }

  const { data, error } = await decideModeration(
    admin,
    listingId,
    gate.requester.userId,
    'rejected',
    parsed.data.reason_code ?? null,
    parsed.data.internal_note ?? null,
    parsed.data.merchant_feedback ?? null,
    parsed.data.idempotency_key
  )

  if (error) {
    console.error('[admin.listings.moderation.reject] RPC error', { listingId, error })
    const mapped = mapAdminRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }

  try {
    const ctx = await loadListingEmailContext(admin, listingId)
    if (ctx) {
      await sendTemplate(admin, {
        eventType: 'listing.moderation_rejected',
        templateId: 'listing-moderation-rejected-merchant',
        recipientUserId: ctx.merchantId,
        relatedEntityType: 'listing',
        relatedEntityId: listingId,
        vars: { merchantName: ctx.merchantName, listingTitle: ctx.listingTitle, feedback: parsed.data.merchant_feedback ?? 'No specific feedback was provided.' },
      })
    }
  } catch (err) {
    console.error('[admin.listings.moderation.reject] email dispatch failed', { listingId, err })
  }

  return NextResponse.json(data)
}
