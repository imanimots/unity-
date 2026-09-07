import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Mirrors src/lib/disputes/evidence-access.ts exactly, for the RTB-native
 * evidence system. Same 120s TTL as every other sensitive-document
 * precedent in this codebase. Authorization is delegated entirely to the
 * caller-supplied `asUser` client (cookie-bound, session-scoped -- never
 * service role): rent_to_buy_evidence's own existing RLS
 * ("rtb_evidence: parties read" / "rtb_evidence: admin read") decides
 * whether the row is visible. The `(id, agreement_id)` compound match
 * stops an evidence id from one RTB agreement being coerced into a
 * different agreement's route param.
 */

const SIGNED_URL_TTL_SECONDS = 120

export interface EvidenceSignedUrlResult {
  url: string
  expiresAt: string
}

export async function getRentToBuyEvidenceSignedUrl(
  asUser: SupabaseClient,
  admin: SupabaseClient,
  agreementId: string,
  evidenceId: string
): Promise<EvidenceSignedUrlResult> {
  const { data: row, error } = await asUser
    .from('rent_to_buy_evidence')
    .select('id, storage_path')
    .eq('id', evidenceId)
    .eq('agreement_id', agreementId)
    .maybeSingle()

  if (error || !row) {
    throw new Error('evidence_not_found')
  }

  const { data: signed, error: signError } = await admin.storage.from('rent-to-buy-evidence').createSignedUrl(row.storage_path, SIGNED_URL_TTL_SECONDS)

  if (signError || !signed) {
    throw new Error('could_not_sign_url')
  }

  return { url: signed.signedUrl, expiresAt: new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000).toISOString() }
}
