import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Mirrors src/lib/listings/evidence-access.ts / src/lib/identity-verification/document-access.ts
 * exactly -- signed URLs, never a permanent link, never stored. Same 120s
 * TTL as both existing sensitive-document precedents in this codebase.
 *
 * Authorization is delegated entirely to the caller-supplied `asUser`
 * client (a cookie-bound, session-scoped client -- never service role):
 * dispute_evidence's own existing RLS ("dispute_evidence: parties read" /
 * "dispute_evidence: admin read", the latter powered by
 * is_dispute_participant(), which already recognizes RTB participants)
 * decides whether the row is visible at all. No authorization logic is
 * reimplemented here. The `(id, dispute_id)` compound match is what stops
 * an evidence id from one dispute being coerced into a different dispute's
 * route param (an otherwise-authorized participant in dispute A supplying
 * dispute B's evidence id) -- both must belong to the same real row.
 *
 * Only once that authenticated read has proven the row visible does this
 * function switch to the passed-in service-role client to actually sign
 * the DB-derived storage_path -- the client never supplies or chooses a
 * storage path itself.
 */

const SIGNED_URL_TTL_SECONDS = 120

export interface EvidenceSignedUrlResult {
  url: string
  expiresAt: string
}

export async function getDisputeEvidenceSignedUrl(
  asUser: SupabaseClient,
  admin: SupabaseClient,
  disputeId: string,
  evidenceId: string
): Promise<EvidenceSignedUrlResult> {
  const { data: row, error } = await asUser
    .from('dispute_evidence')
    .select('id, storage_path')
    .eq('id', evidenceId)
    .eq('dispute_id', disputeId)
    .maybeSingle()

  if (error || !row) {
    throw new Error('evidence_not_found')
  }

  const { data: signed, error: signError } = await admin.storage.from('dispute-evidence').createSignedUrl(row.storage_path, SIGNED_URL_TTL_SECONDS)

  if (signError || !signed) {
    throw new Error('could_not_sign_url')
  }

  return { url: signed.signedUrl, expiresAt: new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000).toISOString() }
}
