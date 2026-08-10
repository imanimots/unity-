import { z } from 'zod'
import { idempotencyKeySchema } from '@/lib/bookings/validation'

const transactionTypeEnum = z.enum(['buy', 'rent', 'barter', 'rent_to_buy'] as const)
const offerTypeEnum = z.enum(['link_listing', 'private_offer', 'message_only', 'public_listing'] as const)

export const createMarketplaceRequestSchema = z
  .object({
    transaction_type: transactionTypeEnum,
    title: z.string().trim().min(3).max(150),
    description: z.string().trim().max(2000).optional(),
    category: z.string().trim().max(60).optional(),
    category_id: z.string().uuid().optional(),
    subcategory_id: z.string().uuid().optional(),
    country_id: z.string().length(2).optional(),
    province: z.string().trim().max(80).optional(),
    city: z.string().trim().max(80).optional(),
    budget_min: z.number().min(0).max(10_000_000).optional(),
    budget_max: z.number().min(0).max(10_000_000).optional(),
    currency: z.string().length(3).optional(),
    start_date: z.string().date().optional(),
    end_date: z.string().date().optional(),
    quantity: z.number().int().min(1).max(1000).optional(),
    condition_preferences: z.string().trim().max(500).optional(),
    barter_offer_description: z.string().trim().max(1000).optional(),
    specifications: z.record(z.string(), z.unknown()).optional(),
    expires_at: z.string().datetime({ offset: true }).optional(),
    idempotency_key: idempotencyKeySchema.optional(),
  })
  .refine((v) => v.transaction_type !== 'rent' || (!!v.start_date && !!v.end_date), {
    message: 'start_date and end_date are required for a rental request',
    path: ['end_date'],
  })
  .refine((v) => !v.start_date || !v.end_date || v.end_date > v.start_date, {
    message: 'end_date must be after start_date',
    path: ['end_date'],
  })
  .refine((v) => v.budget_min === undefined || v.budget_max === undefined || v.budget_max >= v.budget_min, {
    message: 'budget_max must be greater than or equal to budget_min',
    path: ['budget_max'],
  })

// A separate plain-object schema for updates (createMarketplaceRequestSchema
// is wrapped in .refine(), so .partial() isn't available on it directly).
export const updateMarketplaceRequestFieldsSchema = z.object({
  title: z.string().trim().min(3).max(150).optional(),
  description: z.string().trim().max(2000).optional(),
  category: z.string().trim().max(60).optional(),
  category_id: z.string().uuid().optional(),
  subcategory_id: z.string().uuid().optional(),
  province: z.string().trim().max(80).optional(),
  city: z.string().trim().max(80).optional(),
  budget_min: z.number().min(0).max(10_000_000).optional(),
  budget_max: z.number().min(0).max(10_000_000).optional(),
  start_date: z.string().date().optional(),
  end_date: z.string().date().optional(),
  quantity: z.number().int().min(1).max(1000).optional(),
  condition_preferences: z.string().trim().max(500).optional(),
  barter_offer_description: z.string().trim().max(1000).optional(),
  specifications: z.record(z.string(), z.unknown()).optional(),
  expires_at: z.string().datetime({ offset: true }).optional(),
})

export const submitMarketplaceOfferSchema = z
  .object({
    offer_type: offerTypeEnum,
    linked_listing_id: z.string().uuid().optional(),
    amount: z.number().min(0).max(10_000_000).optional(),
    currency: z.string().length(3).optional(),
    rental_start_date: z.string().date().optional(),
    rental_end_date: z.string().date().optional(),
    cash_adjustment: z.number().min(0).max(10_000_000).optional(),
    message: z.string().trim().max(2000).optional(),
    idempotency_key: idempotencyKeySchema.optional(),
  })
  .refine((v) => (v.offer_type !== 'link_listing' && v.offer_type !== 'public_listing') || !!v.linked_listing_id, {
    message: 'linked_listing_id is required for this offer type',
    path: ['linked_listing_id'],
  })

export const requestActionSchema = z.object({
  reason: z.string().trim().max(500).optional(),
  idempotency_key: idempotencyKeySchema.optional(),
})

export const acceptOfferSchema = z.object({
  idempotency_key: idempotencyKeySchema.optional(),
})
