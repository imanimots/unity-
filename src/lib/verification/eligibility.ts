import type { KycStatus } from '@/types'

/**
 * The one authoritative KYC eligibility predicate -- used consistently
 * everywhere a `profiles.kyc_status` gate is needed
 * (src/lib/listings/activation.ts, POST /api/bookings, POST
 * /api/bookings/[id]/start), instead of each call site re-checking
 * `=== 'approved'` independently. Deliberately a pure function over the
 * already-fetched status, not an async DB call itself -- every call site
 * already fetches the relevant profile for other reasons, so this stays
 * a plain predicate rather than adding a redundant round trip.
 *
 * Documented minimum rule for the public-test MVP (per the Step 4 brief):
 *   - browsing: no KYC required
 *   - draft listing creation: no KYC required
 *   - listing activation: approved KYC required for merchants
 *   - booking request / booking start: approved KYC required for renters
 *   - admin review: independent of KYC status
 */
export function isKycApproved(kycStatus: KycStatus | null | undefined): boolean {
  return kycStatus === 'approved'
}
