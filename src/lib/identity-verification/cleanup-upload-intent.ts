import type { SupabaseClient } from '@supabase/supabase-js'
import { parseKycDocumentPath } from './document-access'

const BUCKET = 'kyc-documents'
const INTENTS_TABLE = 'kyc_document_upload_intents'
const METADATA_TABLE = 'identity_verification_documents'

export type CleanupOutcome = 'cleaned' | 'preserved' | 'invalid_path' | 'metadata_error' | 'storage_error'

export interface ExpiredIntentCandidate {
  id: string
  user_id: string
  document_type: 'identity_document' | 'proof_of_address'
  storage_path: string
  is_retry: boolean
}

/**
 * Resolves the Storage/metadata fate of ONE already-claimed
 * (status = 'expired') KYC upload intent -- KYC B3C. Service-role only,
 * called only from POST /api/internal/kyc/cleanup-upload-intents after
 * claim_expired_kyc_upload_intents() has already atomically moved the
 * row to 'expired' (that committed transition is what permanently
 * blocks finalization for this path).
 *
 * Guarantees:
 *  - Never deletes a Storage object whose exact path is referenced by
 *    ANY identity_verification_documents row -- checked fresh here,
 *    immediately before every delete. Registered evidence always wins
 *    (matching or conflicting, doesn't matter).
 *  - Never regresses a terminal state: every write is a conditional
 *    `UPDATE ... WHERE id = $1 AND status = 'expired'`, so a concurrent
 *    worker that already set `cleaned`/`preserved` is not overwritten.
 *  - `cleaned` is written ONLY after both: the fresh metadata check
 *    proved zero rows, AND the Storage object is confirmed absent
 *    (already gone, or deleted successfully).
 *  - Never throws -- returns a typed outcome the route aggregates.
 *  - Fixed bucket, no caller-supplied bucket/path; the path comes from
 *    the intent row the DB claim function returned.
 */
export async function resolveExpiredKycUploadIntent(
  admin: SupabaseClient,
  candidate: ExpiredIntentCandidate
): Promise<CleanupOutcome> {
  // ── 1. Re-validate the stored path against its own intent fields --
  // never trust a corrupted/tampered stored path for a destructive op. ──
  const parsed = parseKycDocumentPath(candidate.storage_path, candidate.user_id, candidate.document_type)
  if (!parsed.ok) {
    return 'invalid_path'
  }

  // ── 2. Fresh registered-metadata guard. ANY row -> never delete. ──
  const { data: metaRows, error: metaError } = await admin
    .from(METADATA_TABLE)
    .select('id')
    .eq('storage_path', candidate.storage_path)

  if (metaError) {
    return 'metadata_error'
  }

  if (metaRows && metaRows.length > 0) {
    // The path is registered through some route other than this
    // intent's own finalize transaction -> preserve the object
    // permanently, retire the intent from cleanup scanning.
    await admin.from(INTENTS_TABLE).update({ status: 'preserved' }).eq('id', candidate.id).eq('status', 'expired')
    return 'preserved'
  }

  // ── 3. Inspect the exact Storage object (metadata-only, never a
  // byte download). ──
  const { error: infoError } = await admin.storage.from(BUCKET).info(candidate.storage_path)

  if (infoError) {
    const status = (infoError as { status?: number }).status
    if (status === 400 || status === 404) {
      // Definitely absent + metadata guard proved zero rows -> the
      // upload was abandoned before it completed. This is a normal B3
      // lifecycle outcome, not an error: successful cleanup.
      await markCleaned(admin, candidate.id)
      return 'cleaned'
    }
    // Ambiguous (network / 5xx / auth) -- "could not verify" is not
    // "definitely absent". Leave expired, retry a future run.
    return 'storage_error'
  }

  // ── 4. Object present, no registered metadata -> delete the exact
  // object (never a prefix, never recursive). ──
  const { error: removeError } = await admin.storage.from(BUCKET).remove([candidate.storage_path])
  if (removeError) {
    return 'storage_error'
  }

  await markCleaned(admin, candidate.id)
  return 'cleaned'
}

async function markCleaned(admin: SupabaseClient, id: string): Promise<void> {
  // Conditional -- a concurrent worker (or a lost-then-retried run) may
  // already have terminated this row; the status guard makes a 0-row
  // update a harmless no-op. If the update is lost after a successful
  // Storage delete, the next run's "object absent" path re-converges
  // to `cleaned`.
  await admin
    .from(INTENTS_TABLE)
    .update({ status: 'cleaned', cleaned_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'expired')
}
