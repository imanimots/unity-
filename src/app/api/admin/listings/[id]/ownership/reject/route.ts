import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { ownershipDecisionSchema } from '@/lib/listings/admin-validation'
import { getOwnershipVerificationProvider, OwnershipVerificationError } from '@/lib/ownership-verification'
import { sendTemplate, loadListingEmailContext } from '@/lib/email'

interface RouteParams {
  params: Promise<{ id: string }>
}

/** POST /api/admin/listings/[id]/ownership/reject -- rejectOwnership() via the OwnershipVerificationService abstraction. */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: listingId } = await params
  if (!isValidUuid(listingId)) {
    return NextResponse.json({ error: 'Invalid listing id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:listings:ownership:reject')
  if (!gate.ok) return gate.response

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  const parsed = ownershipDecisionSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Listing storage is not configured' }, { status: 503 })
  }

  try {
    const provider = getOwnershipVerificationProvider()
    const result = await provider.rejectOwnership(
      { admin },
      listingId,
      gate.requester.userId,
      parsed.data.reason_code ?? null,
      parsed.data.reviewer_notes ?? null,
      parsed.data.merchant_feedback ?? null,
      parsed.data.idempotency_key
    )

    try {
      const ctx = await loadListingEmailContext(admin, listingId)
      if (ctx) {
        await sendTemplate(admin, {
          eventType: 'listing.ownership_rejected',
          templateId: 'listing-ownership-rejected-merchant',
          recipientUserId: ctx.merchantId,
          relatedEntityType: 'listing',
          relatedEntityId: listingId,
          vars: { merchantName: ctx.merchantName, listingTitle: ctx.listingTitle, feedback: parsed.data.merchant_feedback ?? 'No specific feedback was provided.' },
        })
      }
    } catch (emailErr) {
      console.error('[admin.listings.ownership.reject] email dispatch failed', { listingId, emailErr })
    }

    return NextResponse.json(result)
  } catch (err) {
    if (err instanceof OwnershipVerificationError) {
      return NextResponse.json({ error: err.message }, { status: statusForCode(err.code) })
    }
    console.error('[admin.listings.ownership.reject] unexpected error', { listingId, err })
    return NextResponse.json({ error: 'Could not reject ownership verification — please try again' }, { status: 500 })
  }
}

function statusForCode(code: string): number {
  switch (code) {
    case 'duplicate_conflict':
    case 'already_decided':
      return 409
    case 'not_found':
      return 404
    case 'not_authorized':
      return 401
    default:
      return 500
  }
}
