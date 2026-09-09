import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { getAdminServiceClient } from '@/lib/admin/route-helpers'
import { documentUploadRecordSchema, documentUploadFinalizeSchema, MIME_TO_EXTENSION } from '@/lib/identity-verification/validation'
import { parseKycDocumentPath } from '@/lib/identity-verification/document-access'
import { cleanupUnregisteredUpload } from '@/lib/storage-cleanup'

const BUCKET = 'kyc-documents'
const METADATA_TABLE = 'identity_verification_documents'

/**
 * POST /api/verification/documents -- registers an already-uploaded KYC
 * document. Orphan Cleanup Phase B3A: this route now accepts TWO body
 * shapes during the compatibility window.
 *
 *   NEW  -- { intent_id }          -> finalize_kyc_document_upload() RPC
 *   LEGACY -- { document_type, storage_path, mime_type, file_size }
 *                                   -> today's unmodified B1 logic
 *
 * The legacy branch exists ONLY so an already-open browser tab running
 * pre-B3A JS keeps working after this deploys -- it is completely
 * unmodified from B1, byte-for-byte the same behavior, and stays until
 * a separate, later, evidence-gated phase (B3B) retires it. Client code
 * shipped from this point forward always uses the new shape.
 *
 * Dispatch is strict: a body carrying `intent_id` together with any
 * legacy field is rejected outright rather than guessing which shape
 * was intended.
 *
 * The NEW branch's RPC is the authoritative security boundary (Phase B3
 * Final Database-Authority Gate) -- this route does not re-verify
 * Storage/MIME/size itself for that branch; it only calls the function
 * via the session-bound client (never service-role, so auth.uid()
 * inside the function resolves to the real caller) and maps its typed
 * errors to safe responses.
 */
export async function POST(request: NextRequest) {
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

  const looksLikeIntentBody = typeof body === 'object' && body !== null && 'intent_id' in body
  const looksLikeLegacyBody =
    typeof body === 'object' &&
    body !== null &&
    ('document_type' in body || 'storage_path' in body || 'mime_type' in body || 'file_size' in body)

  if (looksLikeIntentBody && looksLikeLegacyBody) {
    return NextResponse.json({ error: 'Invalid document' }, { status: 400 })
  }

  if (looksLikeIntentBody) {
    return finalizeViaIntent(body)
  }

  return finalizeViaLegacyBody(body, requester.userId)
}

/**
 * NEW branch -- Orphan Cleanup Phase B3A. Takes no userId: identity is
 * derived entirely inside finalize_kyc_document_upload() from its own
 * auth.uid() (the session-bound RPC call below carries the real
 * caller's session, never a parameter) -- this route never needs to
 * know or pass along who the caller is for this branch.
 */
async function finalizeViaIntent(body: unknown) {
  const parsed = documentUploadFinalizeSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid document', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const { createClient: createSessionClient } = await import('@/lib/supabase/server')
  const session = await createSessionClient()
  if (!session) {
    return NextResponse.json({ error: 'Verification storage is not configured' }, { status: 503 })
  }

  // Session-bound client, never service-role -- auth.uid() inside the
  // function must resolve to this real caller (the entire point of the
  // Phase B3 authority model).
  const { data, error } = await session.rpc('finalize_kyc_document_upload', { p_intent_id: parsed.data.intent_id })

  if (error) {
    return NextResponse.json({ error: mapFinalizeErrorMessage(error.message) }, { status: statusForFinalizeError(error.message) })
  }

  // Observability only -- distinguishes intent-backed vs legacy
  // finalizations for the future B3B cutover decision. That decision
  // only needs occurrence counts (did any legacy finalization happen
  // at all), never who -- no userId, storage path, document content,
  // or any other identity detail.
  console.log('[verification.documents] kyc_document_finalize_intent')

  return NextResponse.json(data, { status: 201 })
}

function statusForFinalizeError(message: string): number {
  switch (message) {
    case 'not_authenticated':
      return 401
    case 'intent_not_found':
      return 404
    case 'storage_object_missing':
      return 404
    case 'intent_expired':
    case 'metadata_conflict':
      return 409
    case 'storage_metadata_mismatch':
      return 403
    default:
      return 500
  }
}

function mapFinalizeErrorMessage(message: string): string {
  switch (message) {
    case 'not_authenticated':
      return 'You must be signed in to upload a document'
    case 'intent_not_found':
      return 'This upload could not be found — please start again'
    case 'intent_expired':
      return 'This upload has expired — please upload the document again'
    case 'storage_object_missing':
      return 'No uploaded file was found for this upload'
    case 'storage_metadata_mismatch':
      return 'The uploaded file does not match the submitted document details'
    case 'metadata_conflict':
      return 'This document path is already registered with different details'
    default:
      return 'Could not register this document — please try again'
  }
}

/** LEGACY branch -- unmodified from B1, kept for the B3A compatibility
 * window only (an already-open browser tab running pre-B3A JS). */
async function finalizeViaLegacyBody(body: unknown, userId: string) {
  const parsed = documentUploadRecordSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid document', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }
  const { document_type: documentType, storage_path: storagePath, mime_type: mimeType, file_size: fileSize } = parsed.data

  // ── Establish T2: exact path grammar, not prefix-only. ──
  const pathResult = parseKycDocumentPath(storagePath, userId, documentType)
  if (!pathResult.ok) {
    return NextResponse.json({ error: 'This document does not belong to you' }, { status: 403 })
  }
  if (MIME_TO_EXTENSION[mimeType] !== pathResult.extension) {
    return NextResponse.json({ error: 'Document type does not match the uploaded file' }, { status: 403 })
  }

  const { createClient: createSessionClient } = await import('@/lib/supabase/server')
  const session = await createSessionClient()
  if (!session) {
    return NextResponse.json({ error: 'Verification storage is not configured' }, { status: 503 })
  }
  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Verification storage is not configured' }, { status: 503 })
  }

  const runCleanup = () =>
    cleanupUnregisteredUpload({
      admin,
      bucket: BUCKET,
      storagePath,
      metadataTable: METADATA_TABLE,
      metadataPathColumn: 'storage_path',
      domain: 'kyc-documents',
    })

  try {
    // ── Existing-row lookup, BOTH user_id and storage_path (never rely
    // on the path alone to imply ownership) -- session-bound, so
    // owner-read RLS is the actual scoping authority, this .eq is
    // defense-in-depth on top of it. No uniqueness assumption: fetch
    // every row at this exact path. ──
    const { data: existingRows, error: existingError } = await session
      .from(METADATA_TABLE)
      .select('id, document_type, storage_path, mime_type, file_size, uploaded_at')
      .eq('user_id', userId)
      .eq('storage_path', storagePath)
      .order('uploaded_at', { ascending: false })

    if (existingError) {
      console.error('[verification.documents] existing-row lookup failed', { userId })
      return NextResponse.json({ error: 'Could not register this document — please try again' }, { status: 500 })
    }

    if (existingRows && existingRows.length > 0) {
      const isEffectivelyEqual = (row: (typeof existingRows)[number]) =>
        row.document_type === documentType && row.mime_type === mimeType && row.file_size === fileSize

      if (existingRows.every(isEffectivelyEqual)) {
        // Registered evidence is authoritative and immutable -- a
        // same-metadata replay (e.g. a lost response, client retried the
        // same POST) is an idempotent success. No insert, no cleanup.
        console.log('[verification.documents] kyc_document_finalize_legacy')
        return NextResponse.json(existingRows[0], { status: 200 })
      }
      // At least one existing row at this exact path disagrees with the
      // incoming claim. No insert, no cleanup -- the registered row(s)
      // are never touched here.
      return NextResponse.json({ error: 'This document path is already registered with different details' }, { status: 409 })
    }

    // ── Genuinely new path -- verify the Storage object itself exists
    // before trusting it enough to insert. Metadata-only (info()), never
    // downloads the file's bytes. Service role, used here only for
    // integrity verification, not caller authorization (authorization
    // was already established above). ──
    const { data: objectInfo, error: infoError } = await admin.storage.from(BUCKET).info(storagePath)

    if (infoError) {
      const status = (infoError as { status?: number }).status
      if (status === 400 || status === 404) {
        // Nothing was ever uploaded at this path -- nothing to clean up.
        return NextResponse.json({ error: 'No uploaded file was found at this path' }, { status: 404 })
      }
      // Ambiguous failure (network/auth/5xx) -- fail closed. "Could not
      // verify" is not the same claim as "definitely absent", so this
      // must not be treated as a registerable or a cleanup-eligible
      // state either.
      console.error('[verification.documents] storage existence check failed ambiguously', { userId, status })
      return NextResponse.json({ error: 'Could not verify your uploaded document — please try again' }, { status: 500 })
    }

    if (objectInfo.contentType !== mimeType || objectInfo.size !== fileSize) {
      // The claimed metadata doesn't match the real object. Never delete
      // it here -- it may be a legitimate object with different real
      // contents than claimed; we simply refuse to register the
      // mismatched claim. Nothing was inserted, so nothing to clean up.
      return NextResponse.json({ error: 'The uploaded file does not match the submitted document details' }, { status: 403 })
    }

    // ── Object confirmed present and matching -- insert via the
    // caller's own session so owner-insert RLS remains the real write
    // authority (never service role for this insert). ──
    const { data: row, error: insertError } = await session
      .from(METADATA_TABLE)
      .insert({
        user_id: userId,
        document_type: documentType,
        storage_path: storagePath,
        mime_type: mimeType,
        file_size: fileSize,
      })
      .select('id, document_type, storage_path, mime_type, file_size, uploaded_at')
      .single()

    if (insertError) {
      console.error('[verification.documents] insert error', { userId, error: insertError })
      await runCleanup()
      return NextResponse.json({ error: 'Could not register this document — please try again' }, { status: 500 })
    }

    console.log('[verification.documents] kyc_document_finalize_legacy')
    return NextResponse.json(row, { status: 201 })
  } catch (err) {
    console.error('[verification.documents] unexpected error', { userId, err })
    return NextResponse.json({ error: 'Could not register this document — please try again' }, { status: 500 })
  }
}
