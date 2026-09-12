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

/**
 * LEGACY branch -- kept for the B3A compatibility window only (an
 * already-open browser tab running pre-B3A JS, whose uploads carry
 * self-generated random paths with no intent row).
 *
 * B2L: two changes from the original B1 behaviour, both narrowing
 * authority, neither weakening a check:
 *   1. Any request whose exact storage_path belongs to a
 *      kyc_document_upload_intents row is rejected (409) before any
 *      metadata read/insert or RPC -- the privileged legacy writer must
 *      never be able to register an intent-backed path (that is the
 *      ghost-row race B3C's cleaner must be safe against). Rejected
 *      regardless of the intent's status. A genuine stale pre-B3A tab
 *      never hits this -- its paths have no intent.
 *   2. The final metadata insert (for a true no-intent path) goes
 *      through the service-role client, since B2L drops the
 *      "identity_verification_documents: owner insert" RLS policy. Every
 *      preceding B1 check is unchanged and still runs first.
 *
 * B3M: immediately after the intent gate above confirms zero owning
 * intents, this function records one durable, non-identifying
 * "legacy attempt" increment (record_kyc_legacy_finalize_attempt(),
 * fail-closed) before doing anything else -- see that call site below
 * for the full rationale. Nothing about the B2L gate itself changes.
 */
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
    // ── B2L intent gate. Path ownership is already established (T2
    // above), so this lookup is not a cross-user existence oracle. If
    // the exact path belongs to ANY upload intent, the legacy authority
    // surface must not touch it -- the intent-backed flow
    // (finalize_kyc_document_upload) is the only path that may register
    // it. storage_path is UNIQUE on the intents table, so this is a
    // one-row existence check. Fail closed: a lookup error is NOT
    // "no intent". ──
    const { data: intentRows, error: intentLookupError } = await admin
      .from('kyc_document_upload_intents')
      .select('id')
      .eq('storage_path', storagePath)

    if (intentLookupError) {
      console.error('[verification.documents] legacy intent-gate lookup failed', { userId })
      return NextResponse.json({ error: 'Could not register this document — please try again' }, { status: 500 })
    }
    if (intentRows && intentRows.length > 0) {
      return NextResponse.json(
        { error: 'This upload belongs to the newer verification flow — please refresh and try again' },
        { status: 409 }
      )
    }

    // ── B3M durable observability boundary. This request has now
    // provably: authenticated, matched the legacy body shape, passed
    // structural/path-grammar/MIME validation, and passed the B2L
    // fail-closed intent-ownership gate above with zero owning intents
    // -- it is a genuine authenticated legacy no-intent attempt,
    // counted as request volume regardless of what happens next
    // (replay, conflict, Storage failure, insert failure, or insert
    // success all still count -- a future B3B cutover decision needs
    // to know whether clients are still calling this deprecated
    // contract at all, not just whether they succeed at it).
    //
    // FAIL CLOSED: if the durable increment itself cannot be recorded,
    // no downstream legacy work may proceed. A silently-failing metric
    // write must never let this request appear to "just succeed" while
    // going uncounted -- that would make a future zero reading
    // unreliable, which defeats the entire purpose of this metric. ──
    const { error: metricError } = await admin.rpc('record_kyc_legacy_finalize_attempt')
    if (metricError) {
      console.error('[verification.documents] legacy finalize metric recording failed', { userId })
      return NextResponse.json({ error: 'Could not register this document — please try again' }, { status: 503 })
    }
    // Diagnostic only -- distinguishes "attempt reached the accepted
    // legacy boundary" from the existing success-only
    // kyc_document_finalize_legacy log below. The durable daily
    // aggregate above is the authority for B3B; this log (like that
    // one) carries no identifying content.
    console.log('[verification.documents] kyc_legacy_finalize_attempt_recorded')

    // ── Existing-row lookup, BOTH user_id and storage_path (never rely
    // on the path alone to imply ownership) -- service-role (B2L), so
    // the .eq('user_id', ...) is the explicit scoping authority. No
    // uniqueness assumption: fetch every row at this exact path. ──
    const { data: existingRows, error: existingError } = await admin
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

    // ── True no-intent path, object confirmed present and matching --
    // insert via the service-role client (B2L: the owner-insert RLS
    // policy is gone). Every preceding check -- caller auth, exact path
    // ownership, doc-type/MIME consistency, no owning intent, Storage
    // object existence, real MIME/size match, replay/conflict -- has
    // already run; this is the controlled server write, not a bypass. ──
    const { data: row, error: insertError } = await admin
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
