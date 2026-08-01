import type {
  OwnershipVerificationProvider,
  OwnershipVerificationContext,
  OwnershipDecisionResult,
  OwnershipVerificationStatusResult,
} from './types'

const NOT_IMPLEMENTED = 'SumsubOwnershipVerificationProvider is not implemented -- see docs/ADMIN_MODERATION.md'

/**
 * Future stub only -- explicitly out of scope for the public-test MVP
 * (no real Sumsub API, no document recognition, no OCR). Exists so the
 * registry and every call site are already written against the real
 * intended provider name; every method throws until a real integration
 * phase fills these in. Full parameter lists are declared (even though
 * unused) so this class genuinely satisfies OwnershipVerificationProvider's
 * call signatures, not just an assignability check -- callers that already
 * pass every argument a real provider would need continue to type-check
 * against this stub too. See docs/ADMIN_MODERATION.md "Future Sumsub
 * replacement plan" for what implementing this for real would involve.
 */
export class SumsubOwnershipVerificationProvider implements OwnershipVerificationProvider {
  readonly name = 'sumsub'

  async startReview(_ctx: OwnershipVerificationContext, _listingId: string, _adminId: string, _idempotencyKey?: string): Promise<OwnershipDecisionResult> {
    void _ctx
    void _listingId
    void _adminId
    void _idempotencyKey
    throw new Error(NOT_IMPLEMENTED)
  }

  async approveOwnership(
    _ctx: OwnershipVerificationContext,
    _listingId: string,
    _adminId: string,
    _reasonCode: string | null,
    _reviewerNotes: string | null,
    _merchantFeedback: string | null,
    _idempotencyKey?: string
  ): Promise<OwnershipDecisionResult> {
    void _ctx
    void _listingId
    void _adminId
    void _reasonCode
    void _reviewerNotes
    void _merchantFeedback
    void _idempotencyKey
    throw new Error(NOT_IMPLEMENTED)
  }

  async rejectOwnership(
    _ctx: OwnershipVerificationContext,
    _listingId: string,
    _adminId: string,
    _reasonCode: string | null,
    _reviewerNotes: string | null,
    _merchantFeedback: string | null,
    _idempotencyKey?: string
  ): Promise<OwnershipDecisionResult> {
    void _ctx
    void _listingId
    void _adminId
    void _reasonCode
    void _reviewerNotes
    void _merchantFeedback
    void _idempotencyKey
    throw new Error(NOT_IMPLEMENTED)
  }

  async requestAdditionalEvidence(
    _ctx: OwnershipVerificationContext,
    _listingId: string,
    _adminId: string,
    _reasonCode: string | null,
    _reviewerNotes: string | null,
    _merchantFeedback: string | null,
    _idempotencyKey?: string
  ): Promise<OwnershipDecisionResult> {
    void _ctx
    void _listingId
    void _adminId
    void _reasonCode
    void _reviewerNotes
    void _merchantFeedback
    void _idempotencyKey
    throw new Error(NOT_IMPLEMENTED)
  }

  async getVerificationStatus(_ctx: OwnershipVerificationContext, _listingId: string): Promise<OwnershipVerificationStatusResult> {
    void _ctx
    void _listingId
    throw new Error(NOT_IMPLEMENTED)
  }
}
