import { computeListingCompleteness } from './completeness'
import type { CompletenessInput } from './completeness'
import { getRiskRequirements } from '@/lib/risk/engine'
import type { RiskTier } from '@/lib/risk/engine'
import type { OwnershipVerificationStatus } from '@/lib/ownership-verification'
import { isKycApproved } from '@/lib/verification/eligibility'

/**
 * The one server-authoritative activation-eligibility function, called
 * from POST /api/admin/listings/[id]/activate before activate_listing()
 * is ever invoked (which itself only re-checks the cheap SQL-expressible
 * subset -- see that RPC's own comment in
 * 20260803000003_admin_moderation_rpcs.sql). Reuses
 * computeListingCompleteness() rather than duplicating any of its checks
 * -- the only NEW checks here are the ones completeness.ts doesn't and
 * shouldn't know about: moderation verdict, ownership verification
 * (against the listing's own risk tier), and the risk-tier deposit/
 * insurance mandates (stricter than completeness.ts's "deposit amount
 * required only if the merchant opted into a deposit" check).
 *
 * Pure function -- no I/O -- exactly like completeness.ts, for the same
 * reason: directly unit-testable, and the caller controls exactly what
 * "current persisted state" means.
 */
export interface ActivationInput extends CompletenessInput {
  listingStatus: string
  moderationStatus: string | null
  ownershipVerificationStatus: OwnershipVerificationStatus
  riskTier: RiskTier
  insuranceAmount?: number | null
}

export interface ActivationEligibilityResult {
  eligible: boolean
  reasons: string[]
}

const ACTIVATABLE_STATUSES = ['pending', 'suspended']

export function checkActivationEligibility(input: ActivationInput): ActivationEligibilityResult {
  const reasons: string[] = []

  if (!ACTIVATABLE_STATUSES.includes(input.listingStatus)) {
    reasons.push(`Listing status "${input.listingStatus}" is not eligible for activation.`)
  }

  if (input.moderationStatus !== 'approved') {
    reasons.push('This listing has not been approved by moderation.')
  }

  // Step 4 eligibility rule: approved KYC is required for merchants at
  // listing activation (docs/IDENTITY_VERIFICATION.md "Eligibility
  // rules") -- the one authoritative predicate, not a re-derived check.
  if (!isKycApproved(input.merchantKycStatus)) {
    reasons.push('The merchant\'s identity has not been verified. Approved KYC is required before a listing can go live.')
  }

  const completeness = computeListingCompleteness(input)
  if (!completeness.isComplete) {
    reasons.push(...completeness.blockingIssues)
  }

  const requirements = getRiskRequirements(input.riskTier)

  if (requirements.ownershipVerificationRequired && input.ownershipVerificationStatus !== 'verified') {
    reasons.push(`This listing's ${input.riskTier} risk tier requires ownership verification, which has not been completed.`)
  }
  if (requirements.depositRequired && !(input.requested_deposit_amount && input.requested_deposit_amount > 0)) {
    reasons.push(`This listing's ${input.riskTier} risk tier requires a deposit, which has not been set.`)
  }
  if (requirements.insuranceRequired && !(input.insuranceAmount && input.insuranceAmount > 0)) {
    reasons.push(`This listing's ${input.riskTier} risk tier requires insurance, which has not been set.`)
  }

  return { eligible: reasons.length === 0, reasons }
}
