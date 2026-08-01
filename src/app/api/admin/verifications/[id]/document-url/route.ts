import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { documentUrlSchema } from '@/lib/identity-verification/validation'
import { getIdentityDocumentSignedUrl } from '@/lib/identity-verification/document-access'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/admin/verifications/[id]/document-url -- the only way to
 * view a submitted KYC document. Mirrors
 * POST /api/admin/listings/[id]/evidence-url (Step 3) exactly: never a
 * permanent URL, 120-second expiry, tighter rate limit than the other
 * admin verification routes since this is the one endpoint that could be
 * used to probe/enumerate documents.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: userId } = await params
  if (!isValidUuid(userId)) {
    return NextResponse.json({ error: 'Invalid user id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:verifications:document-url')
  if (!gate.ok) return gate.response

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  const parsed = documentUrlSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Verification storage is not configured' }, { status: 503 })
  }

  try {
    const result = await getIdentityDocumentSignedUrl(admin, userId, parsed.data.document_id)
    return NextResponse.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message === 'document_not_found') {
      return NextResponse.json({ error: 'Document not found for this user' }, { status: 404 })
    }
    console.error('[admin.verifications.document-url] error', { userId, err })
    return NextResponse.json({ error: 'Could not generate a secure document link' }, { status: 500 })
  }
}
