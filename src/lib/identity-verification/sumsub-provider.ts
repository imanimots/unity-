import type {
  IdentityVerificationProvider,
  IdentityVerificationContext,
  IdentitySubmissionInput,
  IdentityVerificationResult,
  IdentityVerificationStatusResult,
} from './types'

const NOT_IMPLEMENTED = 'SumsubIdentityVerificationProvider is not implemented -- see docs/IDENTITY_VERIFICATION.md'

/**
 * Future stub only -- explicitly out of scope for the public-test MVP
 * (no real Sumsub API, no live credentials, no invented webhook
 * payloads, no biometric/OCR logic). Every method throws until a real
 * integration phase fills these in. Full parameter lists are declared
 * (even though unused) so this class genuinely satisfies
 * IdentityVerificationProvider's call signatures -- mirrors
 * src/lib/ownership-verification/sumsub-provider.ts exactly (Step 3's
 * proven shape, including the same lesson about matching real parameter
 * lists rather than 0-arg stubs, which broke a call-site type-check
 * there).
 */
export class SumsubIdentityVerificationProvider implements IdentityVerificationProvider {
  readonly name = 'sumsub'

  async submitVerification(
    _ctx: IdentityVerificationContext,
    _userId: string,
    _input: IdentitySubmissionInput,
    _idempotencyKey?: string
  ): Promise<IdentityVerificationResult> {
    void _ctx
    void _userId
    void _input
    void _idempotencyKey
    throw new Error(NOT_IMPLEMENTED)
  }

  async startReview(_ctx: IdentityVerificationContext, _userId: string, _adminId: string, _idempotencyKey?: string): Promise<IdentityVerificationResult> {
    void _ctx
    void _userId
    void _adminId
    void _idempotencyKey
    throw new Error(NOT_IMPLEMENTED)
  }

  async approve(
    _ctx: IdentityVerificationContext,
    _userId: string,
    _adminId: string,
    _reasonCode: string | null,
    _reviewerNotes: string | null,
    _userFeedback: string | null,
    _idempotencyKey?: string
  ): Promise<IdentityVerificationResult> {
    void _ctx
    void _userId
    void _adminId
    void _reasonCode
    void _reviewerNotes
    void _userFeedback
    void _idempotencyKey
    throw new Error(NOT_IMPLEMENTED)
  }

  async reject(
    _ctx: IdentityVerificationContext,
    _userId: string,
    _adminId: string,
    _reasonCode: string | null,
    _reviewerNotes: string | null,
    _userFeedback: string | null,
    _idempotencyKey?: string
  ): Promise<IdentityVerificationResult> {
    void _ctx
    void _userId
    void _adminId
    void _reasonCode
    void _reviewerNotes
    void _userFeedback
    void _idempotencyKey
    throw new Error(NOT_IMPLEMENTED)
  }

  async requestAdditionalInformation(
    _ctx: IdentityVerificationContext,
    _userId: string,
    _adminId: string,
    _reasonCode: string | null,
    _reviewerNotes: string | null,
    _userFeedback: string | null,
    _idempotencyKey?: string
  ): Promise<IdentityVerificationResult> {
    void _ctx
    void _userId
    void _adminId
    void _reasonCode
    void _reviewerNotes
    void _userFeedback
    void _idempotencyKey
    throw new Error(NOT_IMPLEMENTED)
  }

  async getStatus(_ctx: IdentityVerificationContext, _userId: string): Promise<IdentityVerificationStatusResult> {
    void _ctx
    void _userId
    throw new Error(NOT_IMPLEMENTED)
  }
}
