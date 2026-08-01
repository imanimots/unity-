import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Provider-neutral identity/KYC verification. Every consumer (admin
 * routes, eligibility checks, dashboards) depends only on this
 * interface -- never on ManualIdentityVerificationProvider directly.
 * When a real provider (Sumsub or otherwise) is added later, it
 * implements this same interface and is selected via
 * IDENTITY_VERIFICATION_PROVIDER -- no change to anything that calls
 * getIdentityVerificationProvider(). Mirrors
 * src/lib/ownership-verification/types.ts's exact shape (Step 3) --
 * same abstraction pattern, different domain. See
 * docs/IDENTITY_VERIFICATION.md.
 */
export type IdentityVerificationStatus =
  | 'not_started'
  | 'pending'
  | 'under_review'
  | 'additional_information_required'
  | 'approved'
  | 'rejected'

export interface IdentityVerificationContext {
  admin: SupabaseClient
}

export interface IdentitySubmissionInput {
  legalFirstName: string
  legalSurname: string
  dateOfBirth: string
  idReferenceType: 'sa_id' | 'passport'
  idReferenceNumber: string
  nationality: string
  countryOfResidence: string
  residentialAddress: string
}

export interface IdentityVerificationResult {
  userId: string
  status: IdentityVerificationStatus
  reviewCount?: number
}

export interface IdentityVerificationStatusResult {
  userId: string
  status: IdentityVerificationStatus
  provider: string
  reviewedBy: string | null
  reviewedAt: string | null
}

export interface IdentityVerificationProvider {
  readonly name: string

  /** Normalized create-and-submit -- for the manual provider this is one RPC call; a real provider's createApplicant + submit would compose here. */
  submitVerification(
    ctx: IdentityVerificationContext,
    userId: string,
    input: IdentitySubmissionInput,
    idempotencyKey?: string
  ): Promise<IdentityVerificationResult>

  startReview(ctx: IdentityVerificationContext, userId: string, adminId: string, idempotencyKey?: string): Promise<IdentityVerificationResult>

  approve(
    ctx: IdentityVerificationContext,
    userId: string,
    adminId: string,
    reasonCode: string | null,
    reviewerNotes: string | null,
    userFeedback: string | null,
    idempotencyKey?: string
  ): Promise<IdentityVerificationResult>

  reject(
    ctx: IdentityVerificationContext,
    userId: string,
    adminId: string,
    reasonCode: string | null,
    reviewerNotes: string | null,
    userFeedback: string | null,
    idempotencyKey?: string
  ): Promise<IdentityVerificationResult>

  requestAdditionalInformation(
    ctx: IdentityVerificationContext,
    userId: string,
    adminId: string,
    reasonCode: string | null,
    reviewerNotes: string | null,
    userFeedback: string | null,
    idempotencyKey?: string
  ): Promise<IdentityVerificationResult>

  getStatus(ctx: IdentityVerificationContext, userId: string): Promise<IdentityVerificationStatusResult>
}

export class IdentityVerificationError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'IdentityVerificationError'
    this.code = code
  }
}
