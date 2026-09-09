import type { SupabaseClient } from '@supabase/supabase-js'

export interface CleanupUnregisteredUploadParams {
  /** Service-role client -- this function is server-only. */
  admin: SupabaseClient
  /** Fixed by the calling route's own code -- never taken from a request body. */
  bucket: string
  /**
   * The already-validated storage path (prefix-checked against the
   * authenticated caller and the route's own parent resource by the
   * caller) -- never accepted directly from an unvalidated client field.
   */
  storagePath: string
  /** The metadata table that would carry a row for this exact path if registration had succeeded. */
  metadataTable: string
  /** The column on that table holding the storage path. */
  metadataPathColumn: string
  /** Domain name, for logging only -- never used for authorization. */
  domain: string
}

/**
 * Best-effort compensating cleanup for an evidence/attachment object that
 * was uploaded to Storage but whose registration request failed *after*
 * the caller already proved the path belongs to them and to the route's
 * own parent resource (see each call site's own comment for exactly
 * which failure branches qualify).
 *
 * Mandatory safety guard, race-safe by construction: performs its own
 * fresh existence check against the authoritative metadata table
 * immediately before attempting deletion -- never trusts a value the
 * caller computed earlier, which could be stale (a concurrent request
 * may have registered this exact path in the moments between this
 * request's own failure and this call). If any row references the path,
 * this returns without deleting anything -- registered evidence is
 * immutable and must never be touched here, full stop.
 *
 * Never throws: a cleanup failure is swallowed (logged, domain/bucket
 * only -- never the storage path itself) and must never replace or mask
 * the original registration-failure response the caller is about to
 * return. This is hygiene, not part of the transaction result.
 */
export async function cleanupUnregisteredUpload({
  admin,
  bucket,
  storagePath,
  metadataTable,
  metadataPathColumn,
  domain,
}: CleanupUnregisteredUploadParams): Promise<void> {
  try {
    const { count, error: checkError } = await admin
      .from(metadataTable)
      .select('*', { count: 'exact', head: true })
      .eq(metadataPathColumn, storagePath)

    if (checkError) {
      // Can't prove the path is unregistered -- fail closed (no delete).
      console.error('[storage-cleanup] metadata existence check failed, skipping removal', { domain, bucket })
      return
    }
    if ((count ?? 0) > 0) {
      // Registered -- this is real, immutable evidence. Never delete.
      return
    }

    const { error: removeError } = await admin.storage.from(bucket).remove([storagePath])
    if (removeError) {
      console.error('[storage-cleanup] best-effort removal failed', { domain, bucket })
    }
  } catch (err) {
    console.error('[storage-cleanup] unexpected error during cleanup', { domain, bucket, err })
  }
}
