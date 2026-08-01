import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { startReviewSchema } from '@/lib/identity-verification/validation'
import { getIdentityVerificationProvider, IdentityVerificationError } from '@/lib/identity-verification'

interface RouteParams {
  params: Promise<{ id: string }>
}

/** POST /api/admin/verifications/[id]/start -- moves KYC review into 'under_review' via the IdentityVerificationService abstraction, never ManualIdentityVerificationProvider directly. */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: userId } = await params
  if (!isValidUuid(userId)) {
    return NextResponse.json({ error: 'Invalid user id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:verifications:start')
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
    return NextResponse.json({ error: 'Verification storage is not configured' }, { status: 503 })
  }

  try {
    const provider = getIdentityVerificationProvider()
    const result = await provider.startReview({ admin }, userId, gate.requester.userId, parsed.data.idempotency_key)
    return NextResponse.json(result)
  } catch (err) {
    if (err instanceof IdentityVerificationError) {
      return NextResponse.json({ error: err.message }, { status: statusForCode(err.code) })
    }
    console.error('[admin.verifications.start] unexpected error', { userId, err })
    return NextResponse.json({ error: 'Could not start verification review — please try again' }, { status: 500 })
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
