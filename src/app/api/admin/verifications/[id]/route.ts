import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { listCurrentIdentityDocuments } from '@/lib/identity-verification/document-access'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * GET /api/admin/verifications/[id] -- [id] is a user_id (one
 * identity_verifications row per user). Full review detail: account
 * details, submitted legal identity info, document METADATA only (never
 * a URL -- see POST .../document-url), declarations aren't part of this
 * domain (no equivalent to listing_declarations for KYC this pass),
 * prior decisions/resubmission history via identity_verification_history
 * (admin-only, no merchant-safe split needed -- see
 * 20260804000001's header).
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { id: userId } = await params
  if (!isValidUuid(userId)) {
    return NextResponse.json({ error: 'Invalid user id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:verifications:detail')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Verification storage is not configured' }, { status: 503 })
  }

  const [{ data: profile, error: profileError }, { data: verification }, { data: history }] = await Promise.all([
    admin.from('profiles').select('id, full_name, role, kyc_status, unity_score, created_at, country_id').eq('id', userId).maybeSingle(),
    admin.from('identity_verifications').select('*').eq('user_id', userId).maybeSingle(),
    admin.from('identity_verification_history').select('*').eq('user_id', userId).order('created_at', { ascending: false }),
  ])

  if (profileError || !profile) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const documents = await listCurrentIdentityDocuments(admin, userId)

  return NextResponse.json({
    user: {
      id: profile.id,
      fullName: profile.full_name,
      role: profile.role,
      kycStatus: profile.kyc_status,
      unityScore: profile.unity_score,
      accountCreatedAt: profile.created_at,
      accountCountry: profile.country_id,
    },
    verification: verification
      ? {
          status: verification.status,
          legalFirstName: verification.legal_first_name,
          legalSurname: verification.legal_surname,
          dateOfBirth: verification.date_of_birth,
          idReferenceType: verification.id_reference_type,
          idReferenceNumber: verification.id_reference_number,
          nationality: verification.nationality,
          countryOfResidence: verification.country_of_residence,
          residentialAddress: verification.residential_address,
          provider: verification.provider,
          reviewerNotes: verification.reviewer_notes,
          reasonCode: verification.reason_code,
          userFeedback: verification.user_feedback,
          reviewCount: verification.review_count,
          submittedAt: verification.submitted_at,
          reviewedBy: verification.reviewed_by,
          reviewedAt: verification.reviewed_at,
        }
      : { status: 'not_started' },
    documents,
    history: history ?? [],
  })
}
