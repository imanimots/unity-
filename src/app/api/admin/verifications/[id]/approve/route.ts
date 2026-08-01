import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { identityDecisionSchema } from '@/lib/identity-verification/validation'
import { getIdentityVerificationProvider, IdentityVerificationError } from '@/lib/identity-verification'
import { sendTemplate, loadUserDisplayName } from '@/lib/email'

interface RouteParams {
  params: Promise<{ id: string }>
}

/** POST /api/admin/verifications/[id]/approve -- approve() via the IdentityVerificationService abstraction. Syncs profiles.kyc_status = 'approved' inside the RPC. */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: userId } = await params
  if (!isValidUuid(userId)) {
    return NextResponse.json({ error: 'Invalid user id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:verifications:approve')
  if (!gate.ok) return gate.response

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  const parsed = identityDecisionSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Verification storage is not configured' }, { status: 503 })
  }

  try {
    const provider = getIdentityVerificationProvider()
    const result = await provider.approve(
      { admin },
      userId,
      gate.requester.userId,
      parsed.data.reason_code ?? null,
      parsed.data.reviewer_notes ?? null,
      parsed.data.user_feedback ?? null,
      parsed.data.idempotency_key
    )

    try {
      const userName = await loadUserDisplayName(admin, userId)
      await sendTemplate(admin, {
        eventType: 'verification.approved',
        templateId: 'verification-approved-user',
        recipientUserId: userId,
        relatedEntityType: 'identity_verification',
        relatedEntityId: userId,
        vars: { userName },
      })
    } catch (emailErr) {
      console.error('[admin.verifications.approve] email dispatch failed', { userId, emailErr })
    }

    return NextResponse.json(result)
  } catch (err) {
    if (err instanceof IdentityVerificationError) {
      return NextResponse.json({ error: err.message }, { status: statusForCode(err.code) })
    }
    console.error('[admin.verifications.approve] unexpected error', { userId, err })
    return NextResponse.json({ error: 'Could not approve this verification — please try again' }, { status: 500 })
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
