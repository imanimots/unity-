import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { identitySubmissionSchema } from '@/lib/identity-verification/validation'
import { checkSubmissionCompleteness, submitOrResubmitIdentityVerification } from '@/lib/identity-verification/submit-service'
import { IdentityVerificationError } from '@/lib/identity-verification'
import { getAdminServiceClient } from '@/lib/admin/route-helpers'
import { sendTemplate, loadUserDisplayName } from '@/lib/email'
import { blockIfCannotTransact } from '@/lib/admin/account-status'

/**
 * POST /api/verification/submit -- first-time KYC submission. Document
 * completeness (both required types present) is judged here, against
 * the caller's actual persisted identity_verification_documents rows --
 * never trusted from the client -- exactly mirroring why
 * src/app/api/listings/[id]/submit/route.ts re-checks completeness
 * server-side. The RPC itself (submit_identity_verification) only
 * re-checks the cheap status guard, same split as every submit-style
 * route in this codebase.
 */
export async function POST(request: NextRequest) {
  const rate = checkRateLimit(`verification:submit:${getClientKey(request)}`, 10, 60_000)
  if (!rate.allowed) {
    return NextResponse.json({ error: 'Too many requests — please slow down' }, { status: 429 })
  }

  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in to submit verification' }, { status: 401 })
  }
  const blocked = blockIfCannotTransact(requester.profile)
  if (blocked) return blocked

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const parsed = identitySubmissionSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid submission', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Verification storage is not configured' }, { status: 503 })
  }

  const completeness = await checkSubmissionCompleteness(admin, requester.userId)
  if (!completeness.isComplete) {
    return NextResponse.json(
      { error: 'Please upload all required documents before submitting', missingDocumentTypes: completeness.missingDocumentTypes },
      { status: 422 }
    )
  }

  try {
    const result = await submitOrResubmitIdentityVerification(
      admin,
      requester.userId,
      {
        legalFirstName: parsed.data.legal_first_name,
        legalSurname: parsed.data.legal_surname,
        dateOfBirth: parsed.data.date_of_birth,
        idReferenceType: parsed.data.id_reference_type,
        idReferenceNumber: parsed.data.id_reference_number,
        nationality: parsed.data.nationality,
        countryOfResidence: parsed.data.country_of_residence,
        residentialAddress: parsed.data.residential_address,
      },
      parsed.data.idempotency_key
    )

    try {
      const userName = await loadUserDisplayName(admin, requester.userId)
      await sendTemplate(admin, {
        eventType: 'verification.submitted',
        templateId: 'verification-submitted-user',
        recipientUserId: requester.userId,
        relatedEntityType: 'identity_verification',
        relatedEntityId: requester.userId,
        occurrenceKey: 'submit',
        vars: { userName },
      })
    } catch (emailErr) {
      console.error('[verification.submit] email dispatch failed', { userId: requester.userId, emailErr })
    }

    return NextResponse.json(result, { status: 201 })
  } catch (err) {
    if (err instanceof IdentityVerificationError) {
      return NextResponse.json({ error: err.message }, { status: statusForCode(err.code) })
    }
    console.error('[verification.submit] unexpected error', { userId: requester.userId, err })
    return NextResponse.json({ error: 'Could not submit your verification — please try again' }, { status: 500 })
  }
}

function statusForCode(code: string): number {
  switch (code) {
    case 'duplicate_conflict':
    case 'not_resubmittable':
      return 409
    case 'not_authorized':
      return 401
    default:
      return 500
  }
}
