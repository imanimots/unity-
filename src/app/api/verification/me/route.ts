import { NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { listCurrentIdentityDocuments } from '@/lib/identity-verification/document-access'
import { getAdminServiceClient } from '@/lib/admin/route-helpers'

/**
 * GET /api/verification/me -- the current user's own KYC status + safe
 * details + which document types are currently on file (never a URL --
 * see POST .../document-url for the admin-only signed-URL path; this
 * pass doesn't give the user their own document viewer either, upload
 * confirmation only). Reads identity_verification_self_view
 * (20260804000001), which already excludes reviewer_notes/reason_code/
 * provider_reference at the RLS-view layer -- this route does not need
 * to filter anything itself.
 */
export async function GET() {
  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
  }

  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  if (!supabase) {
    return NextResponse.json({ error: 'Verification storage is not configured' }, { status: 503 })
  }

  const { data: verification } = await supabase.from('identity_verification_self_view').select('*').maybeSingle()

  const admin = await getAdminServiceClient()
  const documents = admin ? await listCurrentIdentityDocuments(admin, requester.userId) : []

  return NextResponse.json({
    status: verification?.status ?? 'not_started',
    legalFirstName: verification?.legal_first_name ?? null,
    legalSurname: verification?.legal_surname ?? null,
    dateOfBirth: verification?.date_of_birth ?? null,
    idReferenceType: verification?.id_reference_type ?? null,
    idReferenceNumber: verification?.id_reference_number ?? null,
    nationality: verification?.nationality ?? null,
    countryOfResidence: verification?.country_of_residence ?? null,
    residentialAddress: verification?.residential_address ?? null,
    userFeedback: verification?.user_feedback ?? null,
    reviewCount: verification?.review_count ?? 0,
    submittedAt: verification?.submitted_at ?? null,
    reviewedAt: verification?.reviewed_at ?? null,
    documents: documents.map((d) => ({ documentType: d.documentType, uploadedAt: d.uploadedAt })),
  })
}
