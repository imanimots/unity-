import type {
  IdentityVerificationProvider,
  IdentityVerificationContext,
  IdentitySubmissionInput,
  IdentityVerificationResult,
  IdentityVerificationStatusResult,
} from './types'
import { IdentityVerificationError } from './types'

/**
 * Active provider for the public-test MVP -- a human admin makes every
 * decision via the RPCs in 20260804000002_identity_verification_rpcs.sql.
 * No document recognition, no OCR, no biometric matching, no third-party
 * API call. Mirrors src/lib/ownership-verification/manual-provider.ts
 * exactly (Step 3's proven shape).
 */
export class ManualIdentityVerificationProvider implements IdentityVerificationProvider {
  readonly name = 'manual'

  async submitVerification(
    ctx: IdentityVerificationContext,
    userId: string,
    input: IdentitySubmissionInput,
    idempotencyKey?: string
  ): Promise<IdentityVerificationResult> {
    const { data, error } = await ctx.admin.rpc('submit_identity_verification', {
      p_user_id: userId,
      p_legal_first_name: input.legalFirstName,
      p_legal_surname: input.legalSurname,
      p_date_of_birth: input.dateOfBirth,
      p_id_reference_type: input.idReferenceType,
      p_id_reference_number: input.idReferenceNumber,
      p_nationality: input.nationality,
      p_country_of_residence: input.countryOfResidence,
      p_residential_address: input.residentialAddress,
      p_idempotency_key: idempotencyKey ?? null,
    })
    if (error) throw mapRpcError(error.message)
    return { userId: data.user_id, status: data.status, reviewCount: data.review_count }
  }

  async startReview(ctx: IdentityVerificationContext, userId: string, adminId: string, idempotencyKey?: string): Promise<IdentityVerificationResult> {
    const { data, error } = await ctx.admin.rpc('start_identity_review', {
      p_user_id: userId,
      p_admin_id: adminId,
      p_idempotency_key: idempotencyKey ?? null,
    })
    if (error) throw mapRpcError(error.message)
    return { userId: data.user_id, status: data.status }
  }

  async approve(
    ctx: IdentityVerificationContext,
    userId: string,
    adminId: string,
    reasonCode: string | null,
    reviewerNotes: string | null,
    userFeedback: string | null,
    idempotencyKey?: string
  ): Promise<IdentityVerificationResult> {
    return this.decide(ctx, userId, adminId, 'approved', reasonCode, reviewerNotes, userFeedback, idempotencyKey)
  }

  async reject(
    ctx: IdentityVerificationContext,
    userId: string,
    adminId: string,
    reasonCode: string | null,
    reviewerNotes: string | null,
    userFeedback: string | null,
    idempotencyKey?: string
  ): Promise<IdentityVerificationResult> {
    return this.decide(ctx, userId, adminId, 'rejected', reasonCode, reviewerNotes, userFeedback, idempotencyKey)
  }

  async requestAdditionalInformation(
    ctx: IdentityVerificationContext,
    userId: string,
    adminId: string,
    reasonCode: string | null,
    reviewerNotes: string | null,
    userFeedback: string | null,
    idempotencyKey?: string
  ): Promise<IdentityVerificationResult> {
    return this.decide(ctx, userId, adminId, 'additional_information_required', reasonCode, reviewerNotes, userFeedback, idempotencyKey)
  }

  async getStatus(ctx: IdentityVerificationContext, userId: string): Promise<IdentityVerificationStatusResult> {
    const { data } = await ctx.admin
      .from('identity_verifications')
      .select('status, provider, reviewed_by, reviewed_at')
      .eq('user_id', userId)
      .maybeSingle()

    if (data) {
      return { userId, status: data.status, provider: data.provider, reviewedBy: data.reviewed_by, reviewedAt: data.reviewed_at }
    }
    // No row yet -- nothing submitted. Distinct from ownership verification's
    // risk-tier-based implicit default: KYC has no comparable "not required
    // for this user" signal, so a missing row is unambiguously 'not_started'.
    return { userId, status: 'not_started', provider: this.name, reviewedBy: null, reviewedAt: null }
  }

  private async decide(
    ctx: IdentityVerificationContext,
    userId: string,
    adminId: string,
    decision: 'approved' | 'rejected' | 'additional_information_required',
    reasonCode: string | null,
    reviewerNotes: string | null,
    userFeedback: string | null,
    idempotencyKey?: string
  ): Promise<IdentityVerificationResult> {
    const { data, error } = await ctx.admin.rpc('decide_identity_verification', {
      p_user_id: userId,
      p_admin_id: adminId,
      p_decision: decision,
      p_reason_code: reasonCode,
      p_reviewer_notes: reviewerNotes,
      p_user_feedback: userFeedback,
      p_idempotency_key: idempotencyKey ?? null,
    })
    if (error) throw mapRpcError(error.message)
    return { userId: data.user_id, status: data.status }
  }
}

export function mapRpcError(message: string): IdentityVerificationError {
  if (message.includes('idempotency key already used with a different request')) {
    return new IdentityVerificationError('duplicate_conflict', 'This request was already submitted with different data.')
  }
  if (message.includes('already has a final decision')) {
    return new IdentityVerificationError('already_decided', 'Identity verification already has a final decision.')
  }
  if (message.includes('not in a resubmittable state')) {
    return new IdentityVerificationError('not_resubmittable', 'Your verification cannot be resubmitted right now.')
  }
  if (message.includes('no identity verification submission exists')) {
    return new IdentityVerificationError('not_found', 'No verification submission exists for this user.')
  }
  if (message.includes('not authorized') || message.includes('not authenticated')) {
    return new IdentityVerificationError('not_authorized', 'Not authorized.')
  }
  return new IdentityVerificationError('internal_error', 'Could not update identity verification -- please try again.')
}
