import { calculateRiskTier, getRiskRequirements } from '@/lib/risk/engine'
import { CATEGORY_FIELD_SETS, getRequiredCategoryFieldKeys } from './category-fields'
import { DECLARATION_TYPES } from './validation'
import type { KycStatus } from '@/types'

/**
 * Single source of truth for "is this listing ready to submit" — called
 * server-side (src/app/api/listings/[id]/submit/route.ts) before the RPC
 * runs, and the same function renders the wizard's live completeness
 * display. The client can show these results but never overrides them —
 * the server re-runs this exact function on submit regardless of what the
 * client claims. Pure function, no I/O, so it's directly unit-testable.
 *
 * Closure-pass additions: replacement value, quantity, location,
 * available_from, rental-duration coherence, category-specific field
 * *values* (not just which keys are required), deposit/licence coherence,
 * and blocked-date-range validity. `permitted_use`/`prohibited_use` are
 * deliberately NOT made hard requirements — no MVP rule specifies when
 * they'd be mandatory, and inventing one would be exactly the kind of
 * unresolved business rule the wizard spec repeatedly warns against
 * stamping in unilaterally. They're validated (length limits) if provided,
 * never required.
 */

export interface CompletenessInput {
  title?: string
  category?: string
  condition?: string
  description?: string
  // Defaults to 'rental' when omitted — matches the pre-existing behavior
  // for every caller written before the buying/selling feature existed.
  listing_type?: 'rental' | 'sale' | 'both'
  sale_price?: number
  daily_rate?: number
  min_rental_days?: number
  max_rental_days?: number
  shipping_payer?: string
  condition_confirmed?: boolean
  known_defects?: string | null
  replacement_value?: number
  quantity_available?: number
  province?: string | null
  city?: string | null
  available_from?: string | null
  photoCount: number
  hasPrimaryPhoto: boolean
  hasDamagePhoto: boolean
  hasOwnershipProof: boolean
  acceptedDeclarationTypes: string[]
  categoryMetadata?: Record<string, string | undefined>
  privateCategoryMetadata?: Record<string, string | undefined>
  deposit_required?: boolean
  requested_deposit_amount?: number
  driving_licence_required?: boolean
  licence_class?: string | null
  blockedRanges?: { start_date: string; end_date: string }[]
  merchantAuthenticated: boolean
  merchantRole?: string
  merchantKycStatus: KycStatus
  merchantUnityScore: number
}

export interface CompletenessResult {
  isComplete: boolean
  missingFields: string[]
  blockingIssues: string[]
  warnings: string[]
  requiredOwnershipProof: boolean
  requiredMediaShots: string[]
  categorySpecificRequirements: string[]
  allowedNextActions: ('save_draft' | 'submit_for_review')[]
}

const MIN_PHOTO_COUNT = 3

export function computeListingCompleteness(input: CompletenessInput): CompletenessResult {
  const missingFields: string[] = []
  const blockingIssues: string[] = []
  const warnings: string[] = []

  if (!input.merchantAuthenticated) {
    blockingIssues.push('You must be signed in to submit a listing.')
  }
  if (input.merchantRole && input.merchantRole !== 'merchant' && input.merchantRole !== 'both') {
    blockingIssues.push('Only merchant accounts can list items.')
  }

  const listingType = input.listing_type ?? 'rental'
  const rentable = listingType === 'rental' || listingType === 'both'
  const sellable = listingType === 'sale' || listingType === 'both'

  if (!input.title || input.title.trim().length < 10) missingFields.push('title')
  if (!input.category) missingFields.push('category')
  if (!input.condition) missingFields.push('condition')
  if (!input.description || input.description.trim().length < 50) missingFields.push('description')
  if (rentable) {
    if (!input.daily_rate || input.daily_rate <= 0) missingFields.push('daily_rate')
    if (!input.min_rental_days || input.min_rental_days < 1) missingFields.push('min_rental_days')
    if (!input.available_from) missingFields.push('available_from')
  }
  if (sellable) {
    if (!input.sale_price || input.sale_price <= 0) missingFields.push('sale_price')
  }
  if (!input.shipping_payer) missingFields.push('shipping_payer')
  if (!input.condition_confirmed) missingFields.push('condition_confirmed')
  if (!input.replacement_value || input.replacement_value <= 0) missingFields.push('replacement_value')
  if (!input.quantity_available || input.quantity_available < 1) missingFields.push('quantity_available')
  if (!input.province) missingFields.push('province')
  if (!input.city) missingFields.push('city')

  if (input.max_rental_days && input.min_rental_days && input.max_rental_days < input.min_rental_days) {
    blockingIssues.push('Maximum rental duration cannot be less than the minimum.')
  }

  if (input.photoCount < MIN_PHOTO_COUNT) {
    missingFields.push('photos')
    blockingIssues.push(`At least ${MIN_PHOTO_COUNT} photos are required (${input.photoCount} uploaded).`)
  }
  if (!input.hasPrimaryPhoto) {
    missingFields.push('primary_photo')
    blockingIssues.push('One photo must be marked as the primary image.')
  }

  const requiredMediaShots: string[] = []
  const hasDeclaredDefects = !!input.known_defects && input.known_defects.trim().length > 0
  if (hasDeclaredDefects) {
    requiredMediaShots.push('damage_closeup')
    if (!input.hasDamagePhoto) {
      blockingIssues.push('A damage close-up photo is required because defects were declared.')
    }
  }

  const requiredOwnershipProof = true
  if (!input.hasOwnershipProof) {
    missingFields.push('ownership_proof')
    blockingIssues.push('Proof of ownership is required.')
  }

  const missingDeclarations = DECLARATION_TYPES.filter((t) => !input.acceptedDeclarationTypes.includes(t))
  if (missingDeclarations.length > 0) {
    missingFields.push('declarations')
    blockingIssues.push(`${missingDeclarations.length} declaration(s) must be accepted before submitting.`)
  }

  const categorySpecificRequirements = input.category ? getRequiredCategoryFieldKeys(input.category) : []
  if (categorySpecificRequirements.length > 0) {
    const categoryFields = CATEGORY_FIELD_SETS[input.category as keyof typeof CATEGORY_FIELD_SETS]
    const publicKeys = new Set(categoryFields?.public.map((f) => f.key))
    const missingCategoryFields = categorySpecificRequirements.filter((key) => {
      const value = publicKeys.has(key) ? input.categoryMetadata?.[key] : input.privateCategoryMetadata?.[key]
      return !value || !value.trim()
    })
    if (missingCategoryFields.length > 0) {
      missingFields.push('category_fields')
      blockingIssues.push(`Missing required ${input.category} details: ${missingCategoryFields.join(', ')}.`)
    }
  }

  if (input.deposit_required && (!input.requested_deposit_amount || input.requested_deposit_amount <= 0)) {
    missingFields.push('requested_deposit_amount')
    blockingIssues.push('A deposit amount is required when a deposit is requested.')
  }
  if (input.driving_licence_required && !input.licence_class) {
    missingFields.push('licence_class')
    blockingIssues.push('A licence class is required when a driving licence is required.')
  }

  if (input.blockedRanges?.length) {
    const invalidRange = input.blockedRanges.some((r) => r.start_date > r.end_date)
    if (invalidRange) blockingIssues.push('One or more blocked date ranges has a start date after its end date.')

    const sorted = [...input.blockedRanges].sort((a, b) => a.start_date.localeCompare(b.start_date))
    let overlap = false
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].start_date <= sorted[i - 1].end_date) { overlap = true; break }
    }
    if (overlap) blockingIssues.push('Blocked date ranges must not overlap.')
  }

  // Risk-tier implications — informational this pass (the risk tier
  // itself is always computed server-side by the existing DB trigger, and
  // its Phase 2 requirements — ownership verification, manual review —
  // aren't enforceable yet since no admin verification path exists, per
  // docs/LISTING_SCHEMA.md's known limitations). Surfaced as a warning,
  // never a blocking issue this pass.
  if (input.category && input.daily_rate) {
    const tier = calculateRiskTier({
      category: input.category,
      dailyRate: input.daily_rate,
      merchantKycStatus: input.merchantKycStatus,
      merchantUnityScore: input.merchantUnityScore,
    })
    const requirements = getRiskRequirements(tier)
    if (requirements.manualReviewRequired) {
      warnings.push(`This listing will be ${tier} risk tier and requires manual review before it can go live.`)
    }
  }

  if (input.merchantKycStatus !== 'approved') {
    warnings.push('Your identity is not yet verified — this may raise the risk tier and required deposit for this listing.')
  }

  const isComplete = missingFields.length === 0 && blockingIssues.length === 0

  return {
    isComplete,
    missingFields,
    blockingIssues,
    warnings,
    requiredOwnershipProof,
    requiredMediaShots,
    categorySpecificRequirements,
    allowedNextActions: isComplete ? ['save_draft', 'submit_for_review'] : ['save_draft'],
  }
}
