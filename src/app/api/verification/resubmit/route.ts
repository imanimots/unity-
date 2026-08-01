import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { identitySubmissionSchema } from '@/lib/identity-verification/validation'
import { checkSubmissionCompleteness, submitOrResubmitIdentityVerification } from '@/lib/identity-verification/submit-service'
import { IdentityVerificationError } from '@/lib/identity-verification'
import { getAdminServiceClient } from '@/lib/admin/route-helpers'
import { sendTemplate, loadUserDisplayName } from '@/lib/email'

/**
 * POST /api/verification/resubmit -- same underlying RPC as .../submit
 * (submit_identity_verification already allows both a genuine first
 * submission and a resubmission via one status guard -- see its own
 * comment in 20260804000002), kept as a separate route only for UX
 * clarity: this one requires a PRIOR submission to already exist (a
 * user who never submitted anything should use .../submit instead, with
 * its own clearer error path rather than this route's more specific
 * "nothing to resubmit" message).
 */
export async function POST(request: NextRequest) {
  const rate = checkRateLimit(`verification:resubmit:${getClientKey(request)}`, 10, 60_000)
  if (!rate.allowed) {
    return NextResponse.json({ error: 'Too many requests — please slow down' }, { status: 429 })
  }

  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in to resubmit verification' }, { status: 401 })
  }

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

  const { data: existing } = await admin.from('identity_verifications').select('status').eq('user_id', requester.userId).maybeSingle()
  if (!existing || existing.status === 'not_started') {
    return NextResponse.json({ error: 'No prior submission exists to resubmit — please submit for the first time instead' }, { status: 409 })
  }

  const completeness = await checkSubmissionCompleteness(admin, requester.userId)
  if (!completeness.isComplete) {
    return NextResponse.json(
      { error: 'Please upload all required documents before resubmitting', missingDocumentTypes: completeness.missingDocumentTypes },
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
        occurrenceKey: 'resubmit',
        vars: { userName },
      })
    } catch (emailErr) {
      console.error('[verification.resubmit] email dispatch failed', { userId: requester.userId, emailErr })
    }

    return NextResponse.json(result)
  } catch (err) {
    if (err instanceof IdentityVerificationError) {
      return NextResponse.json({ error: err.message }, { status: statusForCode(err.code) })
    }
    console.error('[verification.resubmit] unexpected error', { userId: requester.userId, err })
    return NextResponse.json({ error: 'Could not resubmit your verification — please try again' }, { status: 500 })
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
