import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { getAdminServiceClient } from '@/lib/admin/route-helpers'
import { documentUploadIntentCreateSchema, MIME_TO_EXTENSION } from '@/lib/identity-verification/validation'
import { buildKycDocumentPath } from '@/lib/identity-verification/document-access'

/** Approved Phase B3 grace period -- see the design report for why this
 * is safe: upload and the finalize call are chained synchronously in
 * the client with no legitimate delayed-retry mechanism, so a genuine
 * first-attempt finalize completes within ordinary network latency,
 * never hours. */
const INTENT_TTL_MS = 6 * 60 * 60 * 1000

/**
 * POST /api/verification/documents/intents -- Orphan Cleanup Phase B3A.
 * Creates a staged upload intent BEFORE the browser ever uploads to
 * Storage: server generates the authoritative path (buildKycDocumentPath,
 * never client-supplied), binds the claimed document_type/mime_type/
 * file_size up front, and sets a server-owned expiry. The intent row
 * itself carries no client-facing RLS policy at all (see the migration's
 * own header) -- this route, using the service-role client, is the only
 * way a row is ever created.
 *
 * This does not, by itself, register anything in
 * identity_verification_documents -- that only happens via
 * finalize_kyc_document_upload(), called from
 * POST /api/verification/documents once the browser has actually
 * uploaded to the returned storage_path.
 */
export async function POST(request: NextRequest) {
  const rate = checkRateLimit(`verification:documents:create-intent:${getClientKey(request)}`, 10, 60_000)
  if (!rate.allowed) {
    return NextResponse.json({ error: 'Too many requests — please slow down' }, { status: 429 })
  }

  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in to upload a document' }, { status: 401 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const parsed = documentUploadIntentCreateSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid document', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Verification storage is not configured' }, { status: 503 })
  }

  const extension = MIME_TO_EXTENSION[parsed.data.mime_type]
  const storagePath = buildKycDocumentPath(requester.userId, parsed.data.document_type, extension)
  const expiresAt = new Date(Date.now() + INTENT_TTL_MS).toISOString()

  const { data: intent, error } = await admin
    .from('kyc_document_upload_intents')
    .insert({
      user_id: requester.userId,
      document_type: parsed.data.document_type,
      storage_path: storagePath,
      mime_type: parsed.data.mime_type,
      file_size: parsed.data.file_size,
      expires_at: expiresAt,
    })
    .select('id, storage_path, expires_at')
    .single()

  if (error) {
    console.error('[verification.documents.intents] insert error', { userId: requester.userId })
    // Intent creation happens strictly before any Storage upload -- no
    // object exists yet, so there is nothing to clean up on failure.
    return NextResponse.json({ error: 'Could not start this upload — please try again' }, { status: 500 })
  }

  return NextResponse.json({ intent_id: intent.id, storage_path: intent.storage_path, expires_at: intent.expires_at }, { status: 201 })
}
