import type { SupabaseClient } from '@supabase/supabase-js'

const SIGNED_URL_TTL_SECONDS = 120

export interface MilestoneEvidenceSignedUrlResult {
  url: string
  expiresAt: string
}

/**
 * Mirrors src/lib/messaging/attachment-access.ts and
 * src/lib/disputes/evidence-access.ts exactly: authorization is entirely
 * delegated to barter_milestone_evidence's own existing RLS
 * ("barter_milestone_evidence: participants read" via
 * is_barter_contribution_participant(), "barter_milestone_evidence:
 * admin read") through the caller's cookie-bound client -- never
 * reimplemented here. Only once that read proves the row visible does a
 * SEPARATE service-role client sign the URL.
 *
 * The agreement/milestone consistency check (IDOR protection -- a
 * caller who is legitimately a participant of two different agreements
 * could otherwise pass agreement A's id in the URL while reading
 * evidence that actually belongs to agreement B's milestone) is done
 * via the SERVICE-ROLE client, deliberately not the RLS-scoped one:
 * barter_contribution_milestones/barter_offer_items/barter_offers only
 * carry "parties read" policies, with no admin clause, so an
 * RLS-scoped nested read through them would incorrectly deny an admin
 * caller even though barter_milestone_evidence's own "admin read"
 * policy already authorized them. By this point the top-level RLS read
 * has already proven the caller is authorized to see this exact
 * evidence row (participant or admin) -- resolving its milestone's real
 * agreement is a pure data-integrity/consistency check, not a second
 * authorization decision, so service-role is safe and correct here.
 */
export async function getMilestoneEvidenceSignedUrl(
  asUser: SupabaseClient,
  admin: SupabaseClient,
  agreementId: string,
  milestoneId: string,
  evidenceId: string
): Promise<MilestoneEvidenceSignedUrlResult> {
  const { data: row, error } = await asUser
    .from('barter_milestone_evidence')
    .select('id, storage_path')
    .eq('id', evidenceId)
    .eq('milestone_id', milestoneId)
    .maybeSingle()

  if (error || !row) throw new Error('evidence_not_found')

  const { data: chain, error: chainError } = await admin
    .from('barter_contribution_milestones')
    .select('id, offer_item:barter_offer_items(offer:barter_offers(agreement_id))')
    .eq('id', milestoneId)
    .maybeSingle()

  const chainMilestone = chain as unknown as { offer_item?: { offer?: { agreement_id?: string } | null } | null } | null
  const resolvedAgreementId = chainMilestone?.offer_item?.offer?.agreement_id
  if (chainError || resolvedAgreementId !== agreementId) throw new Error('evidence_not_found')

  const { data: signed, error: signError } = await admin.storage.from('barter-milestone-evidence').createSignedUrl(row.storage_path, SIGNED_URL_TTL_SECONDS)
  if (signError || !signed) throw new Error('could_not_sign_url')

  return { url: signed.signedUrl, expiresAt: new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000).toISOString() }
}
