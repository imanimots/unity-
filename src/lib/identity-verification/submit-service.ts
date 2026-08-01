import type { SupabaseClient } from '@supabase/supabase-js'
import { getIdentityVerificationProvider } from './registry'
import type { IdentitySubmissionInput, IdentityVerificationResult } from './types'
import { listCurrentIdentityDocuments } from './document-access'

/**
 * Single source of truth for "is this KYC submission ready" -- called by
 * both /api/verification/submit and /api/verification/resubmit before
 * ever calling the provider, mirroring why
 * src/app/api/listings/[id]/submit/route.ts judges completeness against
 * persisted state rather than trusting the client. The only requirement
 * for the public-test MVP: one current identity_document and one current
 * proof_of_address document must exist (legal-detail field completeness
 * is already enforced by Zod in validation.ts -- no separate engine
 * needed for a form this small, unlike listings' richer
 * completeness.ts).
 */
export interface SubmissionCompletenessResult {
  isComplete: boolean
  missingDocumentTypes: ('identity_document' | 'proof_of_address')[]
}

export async function checkSubmissionCompleteness(admin: SupabaseClient, userId: string): Promise<SubmissionCompletenessResult> {
  const documents = await listCurrentIdentityDocuments(admin, userId)
  const presentTypes = new Set(documents.map((d) => d.documentType))
  const required: ('identity_document' | 'proof_of_address')[] = ['identity_document', 'proof_of_address']
  const missingDocumentTypes = required.filter((t) => !presentTypes.has(t))
  return { isComplete: missingDocumentTypes.length === 0, missingDocumentTypes }
}

export async function submitOrResubmitIdentityVerification(
  admin: SupabaseClient,
  userId: string,
  input: IdentitySubmissionInput,
  idempotencyKey: string | undefined
): Promise<IdentityVerificationResult> {
  const provider = getIdentityVerificationProvider()
  return provider.submitVerification({ admin }, userId, input, idempotencyKey)
}
