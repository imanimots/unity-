import { z } from 'zod'

/**
 * Wizard submission validation — Phase 2A + closure pass. See
 * docs/LISTING_SCHEMA.md's "Phase 2A — field mapping" for which fields
 * are required vs. deferred. `draftListingSchema` validates the
 * save-draft payload shape. Submission does NOT re-validate a
 * client-resent listing payload against a stricter schema — instead
 * src/app/api/listings/[id]/submit/route.ts fetches the just-saved row
 * from the database and runs src/lib/listings/completeness.ts against
 * that persisted state. This avoids maintaining the same "is this
 * listing complete" rule twice, and means submission is judged on what's
 * actually in the database, not on whatever a client claims it just sent.
 */

export const MIN_PHOTO_COUNT = 3
export const MAX_PHOTO_COUNT = 12
export const ALLOWED_PHOTO_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'] as const
export const MAX_PHOTO_SIZE_BYTES = 10 * 1024 * 1024 // matches the wizard's existing "up to 10MB each" copy

export const MAX_OWNERSHIP_PROOF_COUNT = 1
export const ALLOWED_OWNERSHIP_PROOF_MIME_TYPES = ['image/jpeg', 'image/png', 'application/pdf', 'video/mp4'] as const
export const MAX_OWNERSHIP_PROOF_SIZE_BYTES = 50 * 1024 * 1024 // matches storage bucket config, see 20260729000007

export const MAX_BLOCKED_RANGES = 50

const conditionEnum = z.enum(['new', 'like_new', 'good', 'fair'] as const, { error: 'Please select a condition' })
const shippingPayerEnum = z.enum(['renter', 'merchant', 'split', 'negotiate'] as const)
const mediaTypeEnum = z.enum(['photo', 'video', 'ownership_proof'] as const)
const shotTypeEnum = z.enum([
  'primary', 'front', 'rear', 'side', 'condition_closeup', 'damage_closeup', 'serial_mark',
] as const)
const depositBasisEnum = z.enum(['fixed', 'percentage', 'system_calculated'] as const)
export const DECLARATION_TYPES = [
  'ownership_authority', 'condition_accuracy', 'image_accuracy',
  'legal_and_safe_item', 'platform_terms', 'off_platform_transaction_policy',
] as const
const declarationTypeEnum = z.enum(DECLARATION_TYPES)

// Idempotency key — client-generated once per logical save/submit action
// (see src/app/(dashboard)/dashboard/merchant/listings/new/create-listing-flow.tsx).
// A short opaque string, not necessarily a UUID (crypto.randomUUID() is
// used, but the schema doesn't require that specific format).
export const idempotencyKeySchema = z.string().min(8).max(128)

// Metadata for one already-uploaded file — the file itself was uploaded to
// Storage before this payload is built (see src/lib/listings/storage.ts).
// `url` is validated to actually be a Supabase Storage URL/path (not an
// arbitrary client-supplied string) by the server before use — see
// src/app/api/listings/route.ts.
export const mediaItemSchema = z.object({
  url: z.string().min(1).max(2048),
  type: mediaTypeEnum,
  display_order: z.number().int().min(0).max(100),
  shot_type: shotTypeEnum.optional(),
})

export const blockedDateRangeSchema = z.object({
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date'),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date'),
  reason: z.string().max(200).optional(),
}).refine((r) => r.start_date <= r.end_date, { message: 'Start date must be before or equal to end date', path: ['end_date'] })

export const availabilitySchema = z.array(blockedDateRangeSchema)
  .max(MAX_BLOCKED_RANGES)
  .refine((ranges) => {
    const sorted = [...ranges].sort((a, b) => a.start_date.localeCompare(b.start_date))
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].start_date <= sorted[i - 1].end_date) return false
    }
    return true
  }, { message: 'Blocked date ranges must not overlap' })

const baseListingFields = {
  title: z.string().trim().min(10, 'Title must be at least 10 characters').max(120, 'Title is too long'),
  category: z.string().min(1, 'Please select a category'),
  condition: conditionEnum,
  description: z.string().trim().min(50, 'Description must be at least 50 characters').max(4000, 'Description is too long'),
  listing_type: z.enum(['rental', 'sale', 'both']).optional(),
  sale_price: z.number().positive('Sale price must be a positive amount').max(1_000_000).optional(),
  daily_rate: z.number({ error: 'Required' }).positive('Daily rate must be a positive amount').max(1_000_000),
  weekly_rate: z.number().positive().max(1_000_000).optional(),
  min_rental_days: z.number().int().min(1).max(30),
  max_rental_days: z.number().int().min(1).max(365).optional(),
  shipping_payer: shippingPayerEnum,
  insurance_amount: z.number().min(0).max(1_000_000).optional(),
  min_unity_score: z.number().min(0).max(5).optional(),
  deposit_required: z.boolean(),
  deposit_amount: z.number().min(0).max(1_000_000).optional(),
  accepts_affiliates: z.boolean(),
  affiliate_commission_rate: z.number().min(1).max(50).optional(),
  known_defects: z.string().max(2000).optional(),
  replacement_value: z.number().positive().max(10_000_000).optional(),
  quantity_available: z.number().int().min(1).max(100).optional(),
  province: z.string().max(100).optional(),
  city: z.string().max(100).optional(),
  available_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date').optional(),
  min_booking_notice_days: z.number().int().min(0).max(90).optional(),
  max_advance_booking_days: z.number().int().min(0).max(365).optional(),
  recurring_unavailable_weekdays: z.array(z.number().int().min(0).max(6))
    .refine((days) => new Set(days).size === days.length, { message: 'Weekdays must not repeat' })
    .optional(),
}

export const draftListingSchema = z.object(baseListingFields).partial({
  title: true,
  category: true,
  condition: true,
  description: true,
  daily_rate: true,
  min_rental_days: true,
  shipping_payer: true,
  deposit_required: true,
  accepts_affiliates: true,
}).extend({
  condition_confirmed: z.boolean().optional(),
}).refine(
  (data) => !data.max_rental_days || !data.min_rental_days || data.max_rental_days >= data.min_rental_days,
  { message: 'Maximum rental duration cannot be less than the minimum', path: ['max_rental_days'] }
)

export const requirementsPayloadSchema = z.object({
  deposit_basis: depositBasisEnum.optional(),
  requested_deposit_amount: z.number().min(0).max(1_000_000).optional(),
  verified_identity_required: z.boolean().optional(),
  kyc_approved_required: z.boolean().optional(),
  min_age: z.number().int().min(0).max(120).optional(),
  driving_licence_required: z.boolean().optional(),
  licence_class: z.string().max(50).optional(),
  additional_requirements: z.string().max(2000).optional(),
  permitted_use: z.string().max(2000).optional(),
  prohibited_use: z.string().max(2000).optional(),
  geographic_restriction: z.string().max(500).optional(),
  commercial_use_allowed: z.boolean().optional(),
  sub_rental_allowed: z.boolean().optional(),
  cleaning_requirements: z.string().max(2000).optional(),
  return_condition_requirements: z.string().max(2000).optional(),
  merchant_custom_rules: z.string().max(2000).optional(),
  existing_damage_description: z.string().max(2000).optional(),
  inspection_required_before_handover: z.boolean().optional(),
  inspection_required_on_return: z.boolean().optional(),
  missing_accessory_consequence: z.string().max(1000).optional(),
  lost_item_consequence: z.string().max(1000).optional(),
}).refine(
  (data) => !data.driving_licence_required || !!data.licence_class,
  { message: 'Licence class is required when a driving licence is required', path: ['licence_class'] }
)

// Loose shape at the wire level — the actual per-category allowlist is
// enforced by src/lib/listings/category-fields.ts (client-side) and the
// category_field_definitions table inside save_listing_draft() (server-
// side, authoritative — see 20260729000008). Sensitive keys are validated
// as belonging to the *private* set only via that same allowlist, never by
// naming convention alone.
export const categoryMetadataSchema = z.record(z.string(), z.string().max(200)).optional()

export const saveDraftRequestSchema = z.object({
  listing_id: z.string().uuid().nullable().optional(),
  listing: draftListingSchema,
  requirements: requirementsPayloadSchema.optional(),
  media: z.array(mediaItemSchema).max(MAX_PHOTO_COUNT + MAX_OWNERSHIP_PROOF_COUNT).optional(),
  category_metadata: categoryMetadataSchema,
  private_category_metadata: categoryMetadataSchema,
  availability: availabilitySchema.optional(),
  idempotency_key: idempotencyKeySchema.optional(),
})

// Submission only needs to know which declarations were accepted — every
// other field is validated server-side against the persisted row (see the
// module comment above), not resent by the client.
export const submitRequestSchema = z.object({
  declaration_types: z.array(declarationTypeEnum)
    .min(1, 'At least one declaration must be accepted')
    .refine((types) => new Set(types).size === types.length, { message: 'Duplicate declaration types are not allowed' }),
  idempotency_key: idempotencyKeySchema.optional(),
})

export type SaveDraftRequest = z.infer<typeof saveDraftRequestSchema>
export type SubmitRequest = z.infer<typeof submitRequestSchema>
export type MediaItem = z.infer<typeof mediaItemSchema>
export type BlockedDateRange = z.infer<typeof blockedDateRangeSchema>
