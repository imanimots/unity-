import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { evidenceUrlSchema } from '@/lib/listings/admin-validation'
import { getOwnershipEvidenceSignedUrl } from '@/lib/listings/evidence-access'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/admin/listings/[id]/evidence-url -- the only way to view
 * ownership evidence. Never returns a permanent URL; the signed URL
 * expires in 120s (src/lib/listings/evidence-access.ts) and is never
 * stored. A tighter rate limit than the other admin routes on purpose --
 * this is the one endpoint that can be used to enumerate/probe evidence
 * files, even though it still requires a valid admin session and a
 * matching (listing_id, media_id, type='ownership_proof') row.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: listingId } = await params
  if (!isValidUuid(listingId)) {
    return NextResponse.json({ error: 'Invalid listing id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:listings:evidence-url')
  if (!gate.ok) return gate.response

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  const parsed = evidenceUrlSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Listing storage is not configured' }, { status: 503 })
  }

  try {
    const result = await getOwnershipEvidenceSignedUrl(admin, listingId, parsed.data.media_id)
    return NextResponse.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message === 'evidence_not_found') {
      return NextResponse.json({ error: 'Evidence not found for this listing' }, { status: 404 })
    }
    console.error('[admin.listings.evidence-url] error', { listingId, err })
    return NextResponse.json({ error: 'Could not generate a secure evidence link' }, { status: 500 })
  }
}
