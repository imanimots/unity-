import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { getAdminServiceClient } from '@/lib/admin/route-helpers'
import { documentUploadRecordSchema, MIME_TO_EXTENSION } from '@/lib/identity-verification/validation'
import { parseKycDocumentPath } from '@/lib/identity-verification/document-access'
import { cleanupUnregisteredUpload } from '@/lib/storage-cleanup'

const BUCKET = 'kyc-documents'
const METADATA_TABLE = 'identity_verification_documents'

/**
 * POST /api/verification/documents -- registers an already-uploaded KYC
 * document as an identity_verification_documents row. Replaces the
 * direct client insert kyc-flow.tsx used to perform itself (owner-insert
 * RLS on the table is unchanged and stays the real write authority --
 * this route inserts via the caller's own session, never service role,
 * per the approved Phase B design).
 *
 * Storage upload itself stays a direct browser->Storage call under the
 * existing 'own upload' policy (20260804000001) -- this route never
 * proxies document bytes.
 *
 * Order (each step only reachable after the previous one passes):
 *   1. auth                                          -- pre-T2
 *   2. body parse + schema                            -- pre-T2
 *   3. exact path grammar + MIME/extension consistency -- establishes T2
 *   4. existing-row lookup (session-bound, RLS-scoped) -- registered
 *      evidence is authoritative and immutable: same metadata -> return
 *      it; conflicting metadata -> 409. Neither branch ever inserts or
 *      cleans up.
 *   5. only for a genuinely new path: verify the Storage object itself
 *      exists (info(), metadata-only, never downloads bytes) and that
 *      its actual size/content-type match the claim
 *   6. insert (session-bound client, RLS-authorized)
 *   7. insert failure -> guarded compensating cleanup (service role,
 *      reused unmodified from Phase A)
 *
 * Never calls submit/resubmit, never calls a verification provider,
 * never touches identity_verifications.status or verification history --
 * this route only ever replaces the metadata insert.
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

  const parsed = documentUploadRecordSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid document', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }
  const { document_type: documentType, storage_path: storagePath, mime_type: mimeType, file_size: fileSize } = parsed.data

  // ── Establish T2: exact path grammar, not prefix-only. ──
  const pathResult = parseKycDocumentPath(storagePath, requester.userId, documentType)
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
      .eq('user_id', requester.userId)
      .eq('storage_path', storagePath)
      .order('uploaded_at', { ascending: false })

    if (existingError) {
      console.error('[verification.documents] existing-row lookup failed', { userId: requester.userId })
      return NextResponse.json({ error: 'Could not register this document — please try again' }, { status: 500 })
    }

    if (existingRows && existingRows.length > 0) {
      const isEffectivelyEqual = (row: (typeof existingRows)[number]) =>
        row.document_type === documentType && row.mime_type === mimeType && row.file_size === fileSize

      if (existingRows.every(isEffectivelyEqual)) {
        // Registered evidence is authoritative and immutable -- a
        // same-metadata replay (e.g. a lost response, client retried the
        // same POST) is an idempotent success. No insert, no cleanup.
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
      console.error('[verification.documents] storage existence check failed ambiguously', { userId: requester.userId, status })
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
        user_id: requester.userId,
        document_type: documentType,
        storage_path: storagePath,
        mime_type: mimeType,
        file_size: fileSize,
      })
      .select('id, document_type, storage_path, mime_type, file_size, uploaded_at')
      .single()

    if (insertError) {
      console.error('[verification.documents] insert error', { userId: requester.userId, error: insertError })
      await runCleanup()
      return NextResponse.json({ error: 'Could not register this document — please try again' }, { status: 500 })
    }

    return NextResponse.json(row, { status: 201 })
  } catch (err) {
    console.error('[verification.documents] unexpected error', { userId: requester.userId, err })
    return NextResponse.json({ error: 'Could not register this document — please try again' }, { status: 500 })
  }
}
