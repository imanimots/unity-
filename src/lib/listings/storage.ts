import {
  ALLOWED_PHOTO_MIME_TYPES, MAX_PHOTO_SIZE_BYTES,
  ALLOWED_OWNERSHIP_PROOF_MIME_TYPES, MAX_OWNERSHIP_PROOF_SIZE_BYTES,
} from './validation'

/**
 * Client-side Storage upload helpers — Phase 2A. Files upload directly
 * from the browser to Supabase Storage (RLS-protected by the existing
 * bucket policies, `20260613000001_initial_schema.sql` +
 * `20260729000006_listing_security_hardening.sql`), then the resulting
 * URL/path is sent to the server (src/app/api/listings/route.ts) for the
 * actual DB write — see docs/LISTING_SCHEMA.md's persistence architecture.
 *
 * Object paths are always `{auth.uid()}/{random-uuid}.{ext}` — generated
 * here, never from client-controlled input beyond the file extension
 * (which is sanitized to alphanumeric-only, closing off any path-
 * traversal attempt via a crafted filename). The `{auth.uid()}` prefix is
 * still enforced independently by the bucket's own RLS policy
 * (`auth.uid()::text = (storage.foldername(name))[1]`), so even a bug
 * here couldn't let a caller write into another user's folder.
 */

function sanitizedExtension(fileName: string): string {
  const raw = fileName.split('.').pop() ?? 'bin'
  const clean = raw.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
  return clean || 'bin'
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

function buildObjectPath(userId: string, file: File): string {
  return `${userId}/${randomId()}.${sanitizedExtension(file.name)}`
}

export function validatePhotoFile(file: File): string | null {
  if (!(ALLOWED_PHOTO_MIME_TYPES as readonly string[]).includes(file.type)) {
    return 'Unsupported file type — use JPG, PNG, WEBP, or HEIC.'
  }
  if (file.size > MAX_PHOTO_SIZE_BYTES) {
    return `File is too large — maximum ${MAX_PHOTO_SIZE_BYTES / 1024 / 1024}MB.`
  }
  return null
}

export function validateOwnershipProofFile(file: File): string | null {
  if (!(ALLOWED_OWNERSHIP_PROOF_MIME_TYPES as readonly string[]).includes(file.type)) {
    return 'Unsupported file type — use JPG, PNG, PDF, or MP4.'
  }
  if (file.size > MAX_OWNERSHIP_PROOF_SIZE_BYTES) {
    return `File is too large — maximum ${MAX_OWNERSHIP_PROOF_SIZE_BYTES / 1024 / 1024}MB.`
  }
  return null
}

export interface UploadResult {
  path: string
  url: string
}

/** Public bucket — returns a real public URL. */
export async function uploadListingPhoto(userId: string, file: File): Promise<UploadResult> {
  const { createClient } = await import('@/lib/supabase/client')
  const supabase = createClient()
  const path = buildObjectPath(userId, file)

  const { error } = await supabase.storage.from('listing-media').upload(path, file, {
    cacheControl: '3600',
    upsert: false,
  })
  if (error) throw new Error(`Photo upload failed: ${error.message}`)

  const { data } = supabase.storage.from('listing-media').getPublicUrl(path)
  return { path, url: data.publicUrl }
}

/**
 * Private bucket — no public URL exists. `url` here is the raw storage
 * path, not a fetchable link; any future authorized reader (merchant/
 * admin) must generate a signed URL at read time. Never display this
 * value as if it were a public image src.
 */
export async function uploadOwnershipProof(userId: string, file: File): Promise<UploadResult> {
  const { createClient } = await import('@/lib/supabase/client')
  const supabase = createClient()
  const path = buildObjectPath(userId, file)

  const { error } = await supabase.storage.from('ownership-proofs').upload(path, file, {
    cacheControl: '3600',
    upsert: false,
  })
  if (error) throw new Error(`Ownership proof upload failed: ${error.message}`)

  return { path, url: path }
}

/** Best-effort cleanup — called when a listing creation attempt fails after files were already uploaded. */
export async function removeUploadedFiles(bucket: 'listing-media' | 'ownership-proofs', paths: string[]): Promise<void> {
  if (!paths.length) return
  try {
    const { createClient } = await import('@/lib/supabase/client')
    const supabase = createClient()
    await supabase.storage.from(bucket).remove(paths)
  } catch {
    // Best-effort — an orphaned file is a hygiene issue, not a security one
    // (still scoped under the uploader's own folder), so a cleanup failure
    // must not mask the original error being handled by the caller.
  }
}
