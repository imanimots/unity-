import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Mirrors src/lib/rent-to-buy/evidence-access.ts / src/lib/disputes/evidence-access.ts
 * exactly -- signed URLs, never a permanent link, never stored. Same
 * 120s TTL as every other sensitive-document precedent in this
 * codebase.
 *
 * Authorization is delegated entirely to the caller-supplied `asUser`
 * client (a cookie-bound, session-scoped client -- never service
 * role): booking_condition_evidence's own existing RLS
 * ("booking_condition_evidence: parties read" /
 * "booking_condition_evidence: admin read") decides whether the row is
 * visible at all. No authorization logic is reimplemented here. The
 * `(id, booking_id)` compound match is what stops an evidence id from
 * one booking being coerced into a different booking's route param.
 *
 * Only once that authenticated read has proven the row visible does
 * this function switch to the passed-in service-role client to
 * actually sign the DB-derived storage_path -- the client never
 * supplies or chooses a storage path itself.
 */

const SIGNED_URL_TTL_SECONDS = 120

export interface EvidenceSignedUrlResult {
  url: string
  expiresAt: string
}

export async function getBookingConditionEvidenceSignedUrl(
  asUser: SupabaseClient,
  admin: SupabaseClient,
  bookingId: string,
  evidenceId: string
): Promise<EvidenceSignedUrlResult> {
  const { data: row, error } = await asUser
    .from('booking_condition_evidence')
    .select('id, storage_path')
    .eq('id', evidenceId)
    .eq('booking_id', bookingId)
    .maybeSingle()

  if (error || !row) {
    throw new Error('evidence_not_found')
  }

  const { data: signed, error: signError } = await admin.storage.from('rental-media').createSignedUrl(row.storage_path, SIGNED_URL_TTL_SECONDS)

  if (signError || !signed) {
    throw new Error('could_not_sign_url')
  }

  return { url: signed.signedUrl, expiresAt: new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000).toISOString() }
}
