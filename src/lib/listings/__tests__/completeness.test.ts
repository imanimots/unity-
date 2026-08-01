import { describe, it, expect } from 'vitest'
import { computeListingCompleteness, type CompletenessInput } from '../completeness'
import { DECLARATION_TYPES } from '../validation'

function baseInput(overrides: Partial<CompletenessInput> = {}): CompletenessInput {
  return {
    title: 'DJI Mavic 3 Pro Drone Kit',
    category: 'tech',
    condition: 'like_new',
    description: 'A great drone in excellent condition with all original accessories included and more.',
    daily_rate: 250,
    min_rental_days: 1,
    shipping_payer: 'renter',
    condition_confirmed: true,
    known_defects: null,
    replacement_value: 15000,
    quantity_available: 1,
    province: 'Gauteng',
    city: 'Johannesburg',
    available_from: '2026-08-01',
    photoCount: 3,
    hasPrimaryPhoto: true,
    hasDamagePhoto: false,
    hasOwnershipProof: true,
    acceptedDeclarationTypes: [...DECLARATION_TYPES],
    categoryMetadata: { battery_condition: 'good', charger_included: 'yes', activation_lock_status: 'unlocked' },
    merchantAuthenticated: true,
    merchantRole: 'merchant',
    merchantKycStatus: 'approved',
    merchantUnityScore: 4.5,
    ...overrides,
  }
}

describe('computeListingCompleteness', () => {
  it('is complete when every requirement is met', () => {
    const result = computeListingCompleteness(baseInput())
    expect(result.isComplete).toBe(true)
    expect(result.blockingIssues).toHaveLength(0)
    expect(result.allowedNextActions).toContain('submit_for_review')
  })

  it('is never complete for an unauthenticated caller', () => {
    const result = computeListingCompleteness(baseInput({ merchantAuthenticated: false }))
    expect(result.isComplete).toBe(false)
    expect(result.allowedNextActions).not.toContain('submit_for_review')
  })

  it('blocks a renter-role account from submitting', () => {
    const result = computeListingCompleteness(baseInput({ merchantRole: 'renter' }))
    expect(result.isComplete).toBe(false)
  })

  it('requires at least 3 photos', () => {
    const result = computeListingCompleteness(baseInput({ photoCount: 2 }))
    expect(result.isComplete).toBe(false)
    expect(result.missingFields).toContain('photos')
  })

  it('requires a primary photo even with enough total photos', () => {
    const result = computeListingCompleteness(baseInput({ hasPrimaryPhoto: false }))
    expect(result.isComplete).toBe(false)
    expect(result.missingFields).toContain('primary_photo')
  })

  it('requires ownership proof', () => {
    const result = computeListingCompleteness(baseInput({ hasOwnershipProof: false }))
    expect(result.isComplete).toBe(false)
    expect(result.missingFields).toContain('ownership_proof')
  })

  it('requires condition_confirmed to be true', () => {
    const result = computeListingCompleteness(baseInput({ condition_confirmed: false }))
    expect(result.isComplete).toBe(false)
    expect(result.missingFields).toContain('condition_confirmed')
  })

  it('requires all declarations to be accepted', () => {
    const result = computeListingCompleteness(baseInput({ acceptedDeclarationTypes: [DECLARATION_TYPES[0]] }))
    expect(result.isComplete).toBe(false)
    expect(result.missingFields).toContain('declarations')
  })

  it('requires a damage close-up photo when defects are declared', () => {
    const result = computeListingCompleteness(baseInput({ known_defects: 'Small scratch on the left panel', hasDamagePhoto: false }))
    expect(result.isComplete).toBe(false)
    expect(result.requiredMediaShots).toContain('damage_closeup')
  })

  it('does not require a damage photo when no defects are declared', () => {
    const result = computeListingCompleteness(baseInput({ known_defects: '', hasDamagePhoto: false }))
    expect(result.requiredMediaShots).not.toContain('damage_closeup')
  })

  it('accepts a damage photo when defects are declared and one is present', () => {
    const result = computeListingCompleteness(baseInput({ known_defects: 'Minor wear', hasDamagePhoto: true }))
    expect(result.isComplete).toBe(true)
  })

  it('rejects a non-positive daily_rate', () => {
    const result = computeListingCompleteness(baseInput({ daily_rate: 0 }))
    expect(result.isComplete).toBe(false)
    expect(result.missingFields).toContain('daily_rate')
  })

  it('warns (does not block) on unverified KYC', () => {
    const result = computeListingCompleteness(baseInput({ merchantKycStatus: 'none' }))
    expect(result.isComplete).toBe(true)
    expect(result.warnings.some((w) => w.includes('identity is not yet verified'))).toBe(true)
  })

  it('only allows save_draft when incomplete', () => {
    const result = computeListingCompleteness(baseInput({ photoCount: 0, hasPrimaryPhoto: false, hasOwnershipProof: false }))
    expect(result.allowedNextActions).toEqual(['save_draft'])
  })

  // ── Closure pass ──────────────────────────────────────────────────────

  it('requires replacement_value', () => {
    const result = computeListingCompleteness(baseInput({ replacement_value: undefined }))
    expect(result.isComplete).toBe(false)
    expect(result.missingFields).toContain('replacement_value')
  })

  it('requires quantity_available to be at least 1', () => {
    const result = computeListingCompleteness(baseInput({ quantity_available: 0 }))
    expect(result.isComplete).toBe(false)
    expect(result.missingFields).toContain('quantity_available')
  })

  it('requires province and city', () => {
    const result = computeListingCompleteness(baseInput({ province: undefined, city: undefined }))
    expect(result.missingFields).toEqual(expect.arrayContaining(['province', 'city']))
  })

  it('requires available_from', () => {
    const result = computeListingCompleteness(baseInput({ available_from: undefined }))
    expect(result.missingFields).toContain('available_from')
  })

  it('rejects max_rental_days below min_rental_days', () => {
    const result = computeListingCompleteness(baseInput({ min_rental_days: 10, max_rental_days: 5 }))
    expect(result.isComplete).toBe(false)
    expect(result.blockingIssues.some((b) => b.includes('Maximum rental duration'))).toBe(true)
  })

  it('requires category-specific required fields to have real values, not just be listed', () => {
    const result = computeListingCompleteness(baseInput({ categoryMetadata: { battery_condition: 'good' } })) // missing charger_included, activation_lock_status
    expect(result.isComplete).toBe(false)
    expect(result.missingFields).toContain('category_fields')
  })

  it('checks private category fields too (vehicles: VIN)', () => {
    const result = computeListingCompleteness(baseInput({
      category: 'vehicles',
      categoryMetadata: { transmission: 'automatic', fuel_type: 'petrol' },
      privateCategoryMetadata: {}, // missing vin, registration_number
    }))
    expect(result.isComplete).toBe(false)
    expect(result.blockingIssues.some((b) => b.includes('vin'))).toBe(true)
  })

  it('is complete for vehicles once all required public+private fields are present', () => {
    const result = computeListingCompleteness(baseInput({
      category: 'vehicles',
      categoryMetadata: { transmission: 'automatic', fuel_type: 'petrol' },
      privateCategoryMetadata: { vin: '1HGCM82633A004352', registration_number: 'CA123456' },
    }))
    expect(result.isComplete).toBe(true)
  })

  it('categories with no defined field set have no category-specific requirements', () => {
    const result = computeListingCompleteness(baseInput({ category: 'outdoor' }))
    expect(result.categorySpecificRequirements).toEqual([])
  })

  it('requires a positive deposit amount when a deposit is requested', () => {
    const result = computeListingCompleteness(baseInput({ deposit_required: true, requested_deposit_amount: undefined }))
    expect(result.isComplete).toBe(false)
    expect(result.missingFields).toContain('requested_deposit_amount')
  })

  it('requires a licence class when a driving licence is required', () => {
    const result = computeListingCompleteness(baseInput({ driving_licence_required: true, licence_class: null }))
    expect(result.isComplete).toBe(false)
    expect(result.missingFields).toContain('licence_class')
  })

  it('rejects an inverted blocked date range', () => {
    const result = computeListingCompleteness(baseInput({ blockedRanges: [{ start_date: '2026-09-10', end_date: '2026-09-01' }] }))
    expect(result.blockingIssues.some((b) => b.includes('start date after its end date'))).toBe(true)
  })

  it('rejects overlapping blocked date ranges', () => {
    const result = computeListingCompleteness(baseInput({
      blockedRanges: [
        { start_date: '2026-09-01', end_date: '2026-09-10' },
        { start_date: '2026-09-05', end_date: '2026-09-15' },
      ],
    }))
    expect(result.blockingIssues.some((b) => b.includes('must not overlap'))).toBe(true)
  })

  it('accepts non-overlapping blocked date ranges', () => {
    const result = computeListingCompleteness(baseInput({
      blockedRanges: [
        { start_date: '2026-09-01', end_date: '2026-09-10' },
        { start_date: '2026-09-11', end_date: '2026-09-15' },
      ],
    }))
    expect(result.isComplete).toBe(true)
  })
})
