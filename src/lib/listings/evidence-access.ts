import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * The only path to viewing ownership evidence -- never a public URL, never
 * a permanently stored link. `listing_media.url` holds a bare storage
 * object PATH for the private `ownership-proofs` bucket (not a full URL --
 * confirmed live), e.g. "{merchantId}/{filename}"; this signs that exact
 * path for a short window. Called only from
 * POST /api/admin/listings/[id]/evidence-url, itself gated by
 * requireAdmin() -- this function does not re-check admin status, it
 * trusts its caller, same as every other service-layer function in this
 * codebase that takes an already-authorized service-role client.
 *
 * The listing_id + type='ownership_proof' filter (not just the media id
 * alone) is what stops one admin's request from being coerced into
 * signing a URL for evidence belonging to a different listing than the
 * one named in the route -- both must match the same row.
 */

const SIGNED_URL_TTL_SECONDS = 120

export interface EvidenceSignedUrlResult {
  url: string
  expiresAt: string
}

export async function getOwnershipEvidenceSignedUrl(admin: SupabaseClient, listingId: string, mediaId: string): Promise<EvidenceSignedUrlResult> {
  const { data: mediaRow, error } = await admin
    .from('listing_media')
    .select('id, url')
    .eq('id', mediaId)
    .eq('listing_id', listingId)
    .eq('type', 'ownership_proof')
    .maybeSingle()

  if (error || !mediaRow) {
    throw new Error('evidence_not_found')
  }

  const { data: signed, error: signError } = await admin.storage.from('ownership-proofs').createSignedUrl(mediaRow.url, SIGNED_URL_TTL_SECONDS)

  if (signError || !signed) {
    throw new Error('could_not_sign_url')
  }

  return { url: signed.signedUrl, expiresAt: new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000).toISOString() }
}

/** Every ownership-proof media row for a listing, without ever returning a URL -- for the review page's "N evidence file(s)" list before any is opened. */
export async function listOwnershipEvidence(admin: SupabaseClient, listingId: string): Promise<{ id: string; createdAt: string }[]> {
  const { data } = await admin.from('listing_media').select('id, created_at').eq('listing_id', listingId).eq('type', 'ownership_proof')
  return (data ?? []).map((row) => ({ id: row.id, createdAt: row.created_at }))
}
