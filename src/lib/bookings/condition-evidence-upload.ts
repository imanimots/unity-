/**
 * Booking condition-evidence file pre-upload validation -- mirrors
 * src/lib/rent-to-buy/evidence-upload.ts's exact shape
 * (ALLOWED_*_MIME_TYPES + MAX_*_SIZE_BYTES + validate*File() returning a
 * stable error identity, never display text). Limits match the
 * existing private `rental-media` bucket's own configuration exactly
 * (supabase/migrations/20260613000001_initial_schema.sql) -- this is
 * convenience/UX only, the authoritative boundary remains the bucket's
 * own server-side MIME allowlist and file_size_limit, never
 * re-implemented or weakened here.
 */

export const ALLOWED_BOOKING_EVIDENCE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'video/mp4', 'video/quicktime'] as const

// Matches the rental-media bucket's own file_size_limit exactly (52428800 bytes).
export const MAX_BOOKING_EVIDENCE_SIZE_BYTES = 50 * 1024 * 1024

export type BookingEvidenceValidationError = 'unsupported_type' | 'too_large'

/**
 * Returns a stable error identity, not display text -- the caller (a
 * Client Component with access to next-intl) maps this to a localized
 * message.
 */
export function validateBookingEvidenceFile(file: File): BookingEvidenceValidationError | null {
  if (!(ALLOWED_BOOKING_EVIDENCE_MIME_TYPES as readonly string[]).includes(file.type)) {
    return 'unsupported_type'
  }
  if (file.size > MAX_BOOKING_EVIDENCE_SIZE_BYTES) {
    return 'too_large'
  }
  return null
}

/**
 * Mirrors the `sanitizedExtension()` helper already duplicated across
 * every sibling evidence/attachment upload path (src/lib/rent-to-buy/evidence-upload.ts,
 * src/lib/disputes/evidence.ts, src/lib/barter/offer-media.ts,
 * src/lib/listings/storage.ts, src/lib/messaging/attachments.ts) -- never
 * derives the storage-key extension directly from unsanitized
 * `file.name`.
 */
export function sanitizeBookingEvidenceExtension(fileName: string): string {
  const raw = fileName.split('.').pop() ?? 'bin'
  const clean = raw.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
  return clean || 'bin'
}

export function bookingEvidenceFileType(mimeType: string): 'image' | 'video' {
  return mimeType.startsWith('video/') ? 'video' : 'image'
}
