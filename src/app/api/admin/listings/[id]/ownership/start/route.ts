import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { startReviewSchema } from '@/lib/listings/admin-validation'
import { getOwnershipVerificationProvider, OwnershipVerificationError } from '@/lib/ownership-verification'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/admin/listings/[id]/ownership/start -- moves ownership
 * verification into 'under_review'. Calls the OwnershipVerificationService
 * abstraction (getOwnershipVerificationProvider()), never
 * ManualOwnershipVerificationProvider directly -- this is the boundary a
 * future Sumsub provider slots into without this route changing at all.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: listingId } = await params
  if (!isValidUuid(listingId)) {
    return NextResponse.json({ error: 'Invalid listing id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:listings:ownership:start')
  if (!gate.ok) return gate.response

  let body: unknown
  try {
    body = await request.json()
  } catch {
    body = {}
  }
  const parsed = startReviewSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Listing storage is not configured' }, { status: 503 })
  }

  try {
    const provider = getOwnershipVerificationProvider()
    const result = await provider.startReview({ admin }, listingId, gate.requester.userId, parsed.data.idempotency_key)
    return NextResponse.json(result)
  } catch (err) {
    if (err instanceof OwnershipVerificationError) {
      return NextResponse.json({ error: err.message }, { status: statusForCode(err.code) })
    }
    console.error('[admin.listings.ownership.start] unexpected error', { listingId, err })
    return NextResponse.json({ error: 'Could not start ownership review — please try again' }, { status: 500 })
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
