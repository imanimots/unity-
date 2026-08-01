import { getRiskRequirements } from '@/lib/risk/engine'
import type { RiskTier } from '@/lib/risk/engine'
import type {
  OwnershipVerificationProvider,
  OwnershipVerificationContext,
  OwnershipDecisionResult,
  OwnershipVerificationStatusResult,
} from './types'
import { OwnershipVerificationError } from './types'

/**
 * Active provider for the public-test MVP -- a human admin makes every
 * decision via the RPCs in 20260803000003_admin_moderation_rpcs.sql. No
 * document recognition, no OCR, no third-party API call. Every method
 * here is a thin, direct call to one RPC; all the actual state-machine
 * logic (final-decision guard, idempotency, history) lives in SQL, the
 * same split submit_listing_for_review() already established.
 */
export class ManualOwnershipVerificationProvider implements OwnershipVerificationProvider {
  readonly name = 'manual'

  async startReview(ctx: OwnershipVerificationContext, listingId: string, adminId: string, idempotencyKey?: string): Promise<OwnershipDecisionResult> {
    const { data, error } = await ctx.admin.rpc('start_ownership_review', {
      p_listing_id: listingId,
      p_admin_id: adminId,
      p_idempotency_key: idempotencyKey ?? null,
    })
    if (error) throw mapRpcError(error.message)
    return { listingId: data.listing_id, status: data.ownership_verification_status }
  }

  async approveOwnership(
    ctx: OwnershipVerificationContext,
    listingId: string,
    adminId: string,
    reasonCode: string | null,
    reviewerNotes: string | null,
    merchantFeedback: string | null,
    idempotencyKey?: string
  ): Promise<OwnershipDecisionResult> {
    return this.decide(ctx, listingId, adminId, 'verified', reasonCode, reviewerNotes, merchantFeedback, idempotencyKey)
  }

  async rejectOwnership(
    ctx: OwnershipVerificationContext,
    listingId: string,
    adminId: string,
    reasonCode: string | null,
    reviewerNotes: string | null,
    merchantFeedback: string | null,
    idempotencyKey?: string
  ): Promise<OwnershipDecisionResult> {
    return this.decide(ctx, listingId, adminId, 'rejected', reasonCode, reviewerNotes, merchantFeedback, idempotencyKey)
  }

  async requestAdditionalEvidence(
    ctx: OwnershipVerificationContext,
    listingId: string,
    adminId: string,
    reasonCode: string | null,
    reviewerNotes: string | null,
    merchantFeedback: string | null,
    idempotencyKey?: string
  ): Promise<OwnershipDecisionResult> {
    return this.decide(ctx, listingId, adminId, 'additional_evidence_required', reasonCode, reviewerNotes, merchantFeedback, idempotencyKey)
  }

  /**
   * No row exists in listing_ownership_verification until a review
   * actually starts (see 20260803000001's header comment) -- a missing
   * row is not an error, it's an implicit default computed from the
   * listing's own risk tier (already DB-computed, authoritative, never
   * re-derived here): 'not_required' if the tier doesn't require
   * ownership verification, 'pending' otherwise.
   */
  async getVerificationStatus(ctx: OwnershipVerificationContext, listingId: string): Promise<OwnershipVerificationStatusResult> {
    const { data: row } = await ctx.admin
      .from('listing_ownership_verification')
      .select('status, provider, reviewed_by, reviewed_at')
      .eq('listing_id', listingId)
      .maybeSingle()

    if (row) {
      return { listingId, status: row.status, provider: row.provider, reviewedBy: row.reviewed_by, reviewedAt: row.reviewed_at }
    }

    const { data: listing } = await ctx.admin.from('listings').select('risk_tier').eq('id', listingId).maybeSingle()
    const tier = (listing?.risk_tier as RiskTier | null) ?? 'low'
    const required = getRiskRequirements(tier).ownershipVerificationRequired

    return { listingId, status: required ? 'pending' : 'not_required', provider: this.name, reviewedBy: null, reviewedAt: null }
  }

  private async decide(
    ctx: OwnershipVerificationContext,
    listingId: string,
    adminId: string,
    decision: 'verified' | 'rejected' | 'additional_evidence_required',
    reasonCode: string | null,
    reviewerNotes: string | null,
    merchantFeedback: string | null,
    idempotencyKey?: string
  ): Promise<OwnershipDecisionResult> {
    const { data, error } = await ctx.admin.rpc('decide_ownership_verification', {
      p_listing_id: listingId,
      p_admin_id: adminId,
      p_decision: decision,
      p_reason_code: reasonCode,
      p_reviewer_notes: reviewerNotes,
      p_merchant_feedback: merchantFeedback,
      p_idempotency_key: idempotencyKey ?? null,
    })
    if (error) throw mapRpcError(error.message)
    return { listingId: data.listing_id, status: data.ownership_verification_status }
  }
}

export function mapRpcError(message: string): OwnershipVerificationError {
  if (message.includes('idempotency key already used with a different request')) {
    return new OwnershipVerificationError('duplicate_conflict', 'This request was already submitted with different data.')
  }
  if (message.includes('already has a final decision')) {
    return new OwnershipVerificationError('already_decided', 'Ownership verification for this listing already has a final decision.')
  }
  if (message.includes('listing not found')) {
    return new OwnershipVerificationError('not_found', 'Listing not found.')
  }
  if (message.includes('not authorized') || message.includes('not authenticated')) {
    return new OwnershipVerificationError('not_authorized', 'Not authorized.')
  }
  return new OwnershipVerificationError('internal_error', 'Could not update ownership verification -- please try again.')
}
