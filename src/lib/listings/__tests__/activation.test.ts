import { describe, it, expect } from 'vitest'
import { checkActivationEligibility } from '../activation'
import type { ActivationInput } from '../activation'

const BASE_COMPLETE: ActivationInput = {
  title: 'A perfectly complete listing title',
  category: 'outdoor',
  condition: 'good',
  description: 'A'.repeat(60),
  daily_rate: 100,
  min_rental_days: 1,
  shipping_payer: 'renter',
  condition_confirmed: true,
  known_defects: null,
  replacement_value: 1000,
  quantity_available: 1,
  province: 'Gauteng',
  city: 'Johannesburg',
  available_from: '2026-01-01',
  photoCount: 3,
  hasPrimaryPhoto: true,
  hasDamagePhoto: false,
  hasOwnershipProof: true,
  acceptedDeclarationTypes: ['ownership_authority', 'condition_accuracy', 'image_accuracy', 'legal_and_safe_item', 'platform_terms', 'off_platform_transaction_policy'],
  merchantAuthenticated: true,
  merchantRole: 'merchant',
  merchantKycStatus: 'approved',
  merchantUnityScore: 5,
  listingStatus: 'pending',
  moderationStatus: 'approved',
  ownershipVerificationStatus: 'not_required',
  riskTier: 'low',
}

describe('checkActivationEligibility', () => {
  it('is eligible for a complete, approved, low-risk listing in pending status', () => {
    const result = checkActivationEligibility(BASE_COMPLETE)
    expect(result.eligible).toBe(true)
    expect(result.reasons).toEqual([])
  })

  it('is eligible for a previously suspended listing whose moderation approval still stands (recovery path)', () => {
    const result = checkActivationEligibility({ ...BASE_COMPLETE, listingStatus: 'suspended' })
    expect(result.eligible).toBe(true)
  })

  it('rejects a listing whose status is not pending or suspended', () => {
    const result = checkActivationEligibility({ ...BASE_COMPLETE, listingStatus: 'draft' })
    expect(result.eligible).toBe(false)
    expect(result.reasons.some((r) => r.includes('not eligible for activation'))).toBe(true)
  })

  it('rejects a listing moderation has not approved', () => {
    const result = checkActivationEligibility({ ...BASE_COMPLETE, moderationStatus: 'pending' })
    expect(result.eligible).toBe(false)
    expect(result.reasons.some((r) => r.includes('not been approved by moderation'))).toBe(true)
  })

  it('rejects activation when the merchant has not been KYC-approved (Step 4 eligibility rule)', () => {
    const result = checkActivationEligibility({ ...BASE_COMPLETE, merchantKycStatus: 'none' })
    expect(result.eligible).toBe(false)
    expect(result.reasons.some((r) => r.toLowerCase().includes('identity') && r.toLowerCase().includes('verified'))).toBe(true)
  })

  it('rejects activation for a pending merchant KYC status too, not just "none"/"rejected"', () => {
    const result = checkActivationEligibility({ ...BASE_COMPLETE, merchantKycStatus: 'pending' })
    expect(result.eligible).toBe(false)
  })

  it('rejects an incomplete listing (missing photos), reusing computeListingCompleteness rather than a separate check', () => {
    const result = checkActivationEligibility({ ...BASE_COMPLETE, photoCount: 1 })
    expect(result.eligible).toBe(false)
    expect(result.reasons.some((r) => r.toLowerCase().includes('photo'))).toBe(true)
  })

  it('requires ownership verification for a risk tier that mandates it, even if moderation already approved', () => {
    const result = checkActivationEligibility({
      ...BASE_COMPLETE,
      riskTier: 'medium',
      ownershipVerificationStatus: 'pending',
    })
    expect(result.eligible).toBe(false)
    expect(result.reasons.some((r) => r.includes('ownership verification'))).toBe(true)
  })

  it('accepts a medium-risk listing once ownership is verified', () => {
    const result = checkActivationEligibility({
      ...BASE_COMPLETE,
      riskTier: 'medium',
      ownershipVerificationStatus: 'verified',
    })
    expect(result.eligible).toBe(true)
  })

  it('requires a deposit for high risk tier regardless of the merchant-set deposit_required flag', () => {
    const result = checkActivationEligibility({
      ...BASE_COMPLETE,
      riskTier: 'high',
      ownershipVerificationStatus: 'verified',
      deposit_required: false,
      requested_deposit_amount: undefined,
      insuranceAmount: 500,
    })
    expect(result.eligible).toBe(false)
    expect(result.reasons.some((r) => r.includes('deposit'))).toBe(true)
  })

  it('requires insurance for high risk tier', () => {
    const result = checkActivationEligibility({
      ...BASE_COMPLETE,
      riskTier: 'high',
      ownershipVerificationStatus: 'verified',
      requested_deposit_amount: 500,
      insuranceAmount: undefined,
    })
    expect(result.eligible).toBe(false)
    expect(result.reasons.some((r) => r.includes('insurance'))).toBe(true)
  })

  it('is eligible for a fully-satisfied high-risk listing', () => {
    const result = checkActivationEligibility({
      ...BASE_COMPLETE,
      riskTier: 'high',
      ownershipVerificationStatus: 'verified',
      requested_deposit_amount: 500,
      insuranceAmount: 500,
    })
    expect(result.eligible).toBe(true)
  })

  it('collects multiple independent failure reasons at once rather than stopping at the first', () => {
    const result = checkActivationEligibility({
      ...BASE_COMPLETE,
      listingStatus: 'draft',
      moderationStatus: 'pending',
      photoCount: 0,
    })
    expect(result.eligible).toBe(false)
    expect(result.reasons.length).toBeGreaterThanOrEqual(2)
  })
})
