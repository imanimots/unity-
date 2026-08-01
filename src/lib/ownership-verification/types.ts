import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Provider-neutral ownership verification. The rest of the application
 * (admin routes, moderation, listing activation, merchant-facing screens)
 * depends only on this interface -- never on ManualOwnershipVerificationProvider
 * directly. When a real provider (Sumsub or otherwise) is added later, it
 * implements this same interface and is selected via
 * OWNERSHIP_VERIFICATION_PROVIDER -- no change to anything that calls
 * getOwnershipVerificationProvider(). See docs/ADMIN_MODERATION.md.
 */
export type OwnershipVerificationStatus = 'not_required' | 'pending' | 'under_review' | 'additional_evidence_required' | 'verified' | 'rejected'

export interface OwnershipVerificationContext {
  admin: SupabaseClient
}

export interface OwnershipVerificationStatusResult {
  listingId: string
  status: OwnershipVerificationStatus
  provider: string
  reviewedBy: string | null
  reviewedAt: string | null
}

export interface OwnershipDecisionResult {
  listingId: string
  status: OwnershipVerificationStatus
}

export interface OwnershipVerificationProvider {
  readonly name: string

  startReview(ctx: OwnershipVerificationContext, listingId: string, adminId: string, idempotencyKey?: string): Promise<OwnershipDecisionResult>

  approveOwnership(
    ctx: OwnershipVerificationContext,
    listingId: string,
    adminId: string,
    reasonCode: string | null,
    reviewerNotes: string | null,
    merchantFeedback: string | null,
    idempotencyKey?: string
  ): Promise<OwnershipDecisionResult>

  rejectOwnership(
    ctx: OwnershipVerificationContext,
    listingId: string,
    adminId: string,
    reasonCode: string | null,
    reviewerNotes: string | null,
    merchantFeedback: string | null,
    idempotencyKey?: string
  ): Promise<OwnershipDecisionResult>

  requestAdditionalEvidence(
    ctx: OwnershipVerificationContext,
    listingId: string,
    adminId: string,
    reasonCode: string | null,
    reviewerNotes: string | null,
    merchantFeedback: string | null,
    idempotencyKey?: string
  ): Promise<OwnershipDecisionResult>

  getVerificationStatus(ctx: OwnershipVerificationContext, listingId: string): Promise<OwnershipVerificationStatusResult>
}

export class OwnershipVerificationError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'OwnershipVerificationError'
    this.code = code
  }
}
