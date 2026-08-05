/**
 * Offer-scoped evidence media upload helpers — mirrors
 * src/lib/listings/storage.ts's client-side upload pattern exactly.
 * Object paths are {agreement_id}/{offer_id}/{uploader_uid}/{random}.{ext}
 * -- matches the storage RLS policies in
 * 20260810000004_barter_offer_media.sql, which check foldername[1]
 * against barter_agreements.id and foldername[3] against auth.uid().
 */

export const ALLOWED_OFFER_MEDIA_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4'] as const
export const MAX_OFFER_MEDIA_SIZE_BYTES = 10 * 1024 * 1024 // matches the listing-photo limit
export const MAX_OFFER_MEDIA_COUNT = 6

function sanitizedExtension(fileName: string): string {
  const raw = fileName.split('.').pop() ?? 'bin'
  const clean = raw.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
  return clean || 'bin'
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

export function validateOfferMediaFile(file: File): string | null {
  if (!(ALLOWED_OFFER_MEDIA_MIME_TYPES as readonly string[]).includes(file.type)) {
    return 'Unsupported file type — use JPG, PNG, WEBP, or MP4.'
  }
  if (file.size > MAX_OFFER_MEDIA_SIZE_BYTES) {
    return `File is too large — maximum ${MAX_OFFER_MEDIA_SIZE_BYTES / 1024 / 1024}MB.`
  }
  return null
}

function buildOfferMediaPath(agreementId: string, offerId: string, uploaderId: string, file: File): string {
  return `${agreementId}/${offerId}/${uploaderId}/${randomId()}.${sanitizedExtension(file.name)}`
}

export interface OfferMediaUploadResult {
  path: string
  mediaType: 'photo' | 'video'
}

/** Private bucket -- no public URL. Any authorized reader (agreement party/admin) generates a signed URL at read time. */
export async function uploadBarterOfferMedia(
  agreementId: string,
  offerId: string,
  uploaderId: string,
  file: File
): Promise<OfferMediaUploadResult> {
  const { createClient } = await import('@/lib/supabase/client')
  const supabase = createClient()
  const path = buildOfferMediaPath(agreementId, offerId, uploaderId, file)

  const { error } = await supabase.storage.from('barter-offer-media').upload(path, file, {
    cacheControl: '3600',
    upsert: false,
  })
  if (error) throw new Error(`Offer media upload failed: ${error.message}`)

  return { path, mediaType: file.type.startsWith('video/') ? 'video' : 'photo' }
}
