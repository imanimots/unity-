/**
 * RTB evidence file pre-upload validation -- mirrors
 * src/lib/disputes/evidence.ts and src/lib/barter/skill-task-evidence.ts's
 * exact shape (ALLOWED_*_MIME_TYPES + MAX_*_SIZE_BYTES + validate*File()
 * returning a stable error identity, never display text). Kept as its
 * own small domain-specific module rather than a shared cross-domain
 * helper: rent-to-buy-evidence's bucket limits (20MB; image/jpeg|png|webp
 * + video/mp4 + application/pdf) are genuinely wider than the 10MB
 * image/pdf-only dispute/barter buckets, matching this repo's own
 * established one-module-per-domain convention for this exact reason.
 *
 * This is convenience/UX only -- the authoritative boundary remains the
 * rent-to-buy-evidence bucket's own server-side MIME allowlist and
 * file_size_limit (supabase/migrations/20260821183555_rtb_v2_schema.sql),
 * never re-implemented or weakened here.
 */

export const ALLOWED_RTB_EVIDENCE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'application/pdf'] as const

// Matches the bucket's own file_size_limit exactly (20971520 bytes) --
// the same 1024-based (not decimal) byte convention already used by
// MAX_EVIDENCE_SIZE_BYTES/MAX_MILESTONE_EVIDENCE_SIZE_BYTES.
export const MAX_RTB_EVIDENCE_SIZE_BYTES = 20 * 1024 * 1024

export type RtbEvidenceValidationError = 'unsupported_type' | 'too_large'

/**
 * Returns a stable error identity, not display text -- the caller (a
 * Client Component with access to next-intl) maps this to a localized
 * message. Keeps this pure-logic file free of any UI-language concern.
 */
export function validateRentToBuyEvidenceFile(file: File): RtbEvidenceValidationError | null {
  if (!(ALLOWED_RTB_EVIDENCE_MIME_TYPES as readonly string[]).includes(file.type)) {
    return 'unsupported_type'
  }
  if (file.size > MAX_RTB_EVIDENCE_SIZE_BYTES) {
    return 'too_large'
  }
  return null
}
